import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { Avatar, AVATAR_KEYS } from '../components/Avatar.jsx';
import { Turnstile } from '../components/Turnstile.jsx';
import { IconLock, IconSchool } from '../components/icons.jsx';

/**
 * 登录 / 注册（邮箱验证码，无密码）。
 *
 * 三步一条流水线：
 *   1. 填邮箱 → 发验证码（Cloudflare Email Service 发送，未配置时落 outbox + 服务端日志）
 *   2. 填验证码 → 老用户直接建会话；新用户拿到一次性注册令牌
 *   3. 新用户补昵称 + **学校**（选定不可更改）+ 头像
 *
 * 学校是必选且不可改的，所以第三步的按钮在没选学校时是禁用的 ——
 * 与其让服务端返回 400，不如一开始就不让点。
 */
export function AuthSheet({ site }) {
  const { authOpen, closeAuth, completeAuth } = useAuth();
  // 站点配置没有就不启用：后端没配 Turnstile 时前端也不该去加载第三方脚本
  const turnstileCfg = (site && site.turnstile) || null;
  const toast = useToast();

  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [nickname, setNickname] = useState('');
  const [school, setSchool] = useState('');
  const [avatar, setAvatar] = useState('');
  const [schools, setSchools] = useState([]);
  const [schoolsLoaded, setSchoolsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  // 人机验证：token 一次性，每次请求后必须重置 widget 换新的
  const [tsToken, setTsToken] = useState('');
  const [tsReset, setTsReset] = useState(0);
  const [tsError, setTsError] = useState('');
  // 登录通道：邮箱（默认）或手机号。手机通道只在服务端短信通道就绪时出现。
  const [channel, setChannel] = useState('email');
  const [phone, setPhone] = useState('');
  const phoneLoginEnabled = Boolean(site && site.features && site.features.phoneLogin);

  // 打开时重置：上次填到一半的邮箱/验证码不应该被下一个人看到
  useEffect(() => {
    if (!authOpen) return;
    setStep('email');
    setCode('');
    setToken('');
    setBusy(false);
    setTsToken('');
    setTsError('');
    setTsReset((n) => n + 1);
    setChannel('email');
    setPhone('');
  }, [authOpen]);

  // 重发倒计时：服务端 60 秒内只允许发一次，前端跟着走，避免用户白点
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const loadSchools = useCallback(async () => {
    if (schoolsLoaded) return;
    try {
      const data = await api.schools();
      setSchools(Array.isArray(data.items) ? data.items : []);
    } catch {
      setSchools([]);
    } finally {
      setSchoolsLoaded(true);
    }
  }, [schoolsLoaded]);

  /** 当前通道要发送的目标：邮箱 → {email}，手机 → {phone} */
  const codeTarget = () => (channel === 'phone' ? { phone: phone.trim() } : { email: email.trim() });
  const identifier = () => (channel === 'phone' ? phone.trim() : email.trim());
  const identifierReady = () => (channel === 'phone' ? /^\+?[\d\s()-]{6,20}$/.test(phone.trim()) : email.trim().length > 3);

  const sendCode = async () => {
    const value = identifier();
    if (!value) return;
    // 配了 Turnstile 就必须拿到 token 才能发：token 是发给服务端的，前端拦一下只是省一次空请求
    if (turnstileCfg && !tsToken) {
      toast('请先完成下方的人机验证');
      return;
    }
    setBusy(true);
    try {
      const result = await api.auth.requestCode(codeTarget(), tsToken || undefined);
      setStep('code');
      setCooldown(60);
      if (result && result.devCode) {
        // 未配置邮件通道的开发/自托管环境：服务端会把验证码回带，直接填上
        setCode(result.devCode);
        toast('开发模式：验证码已自动填入');
      } else {
        toast('验证码已发送，请查收邮件');
      }
    } catch (err) {
      toast(err.message || '发送失败');
    } finally {
      setBusy(false);
      // token 用一次就失效：无论成功失败都换一个新的 widget
      setTsToken('');
      setTsReset((n) => n + 1);
    }
  };

  const verify = async () => {
    if (code.trim().length !== 6) {
      toast('请输入 6 位验证码');
      return;
    }
    setBusy(true);
    try {
      const result = await api.auth.verify(codeTarget(), code.trim());
      if (result && result.user) {
        completeAuth(result.user);
        toast('欢迎回来');
        return;
      }
      setToken(result.token);
      setStep('profile');
      loadSchools();
    } catch (err) {
      toast(err.message || '验证失败');
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (!school) {
      toast('请先选择学校');
      return;
    }
    setBusy(true);
    try {
      const result = await api.auth.register({
        token,
        nickname: nickname.trim(),
        school,
        avatar
      });
      completeAuth(result.user);
      toast('注册成功，欢迎');
    } catch (err) {
      toast(err.message || '注册失败');
    } finally {
      setBusy(false);
    }
  };

  if (!authOpen) return null;

  const title = step === 'email' ? '登录 / 注册' : step === 'code' ? '输入验证码' : '完善资料';

  return (
    <Sheet open={authOpen} onClose={closeAuth} title={title}>
      {step === 'email' ? (
        <div className="stack-lg">
          <div className="field">
            {phoneLoginEnabled ? (
              <div className="seg" role="tablist" aria-label="登录方式" style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={channel === 'email'}
                  className={'seg-btn' + (channel === 'email' ? ' is-active' : '')}
                  onClick={() => { setChannel('email'); setTsToken(''); setTsReset((n) => n + 1); }}
                >
                  邮箱
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={channel === 'phone'}
                  className={'seg-btn' + (channel === 'phone' ? ' is-active' : '')}
                  onClick={() => { setChannel('phone'); setTsToken(''); setTsReset((n) => n + 1); }}
                >
                  手机号
                </button>
              </div>
            ) : null}
            <label className="field-label" htmlFor="auth-email">{channel === 'phone' ? '手机号' : '邮箱'}</label>
            {channel === 'phone' ? (
              <input
                id="auth-phone"
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="13800138000"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') sendCode(); }}
              />
            ) : (
              <input
                id="auth-email"
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') sendCode(); }}
              />
            )}
            <p className="meta">
              {channel === 'phone'
                ? '手机号需先在「我的 → 设置」里绑定，才能用短信验证码登录。'
                : '用邮箱验证码登录，没有密码，不需要手机号。'}
            </p>
          </div>
          {turnstileCfg ? (
            <div className="turnstile-block">
              <Turnstile
                siteKey={turnstileCfg.siteKey}
                action={turnstileCfg.action || 'login'}
                onToken={(token) => { setTsToken(token); if (token) setTsError(''); }}
                onError={(msg) => setTsError(msg)}
                resetSignal={tsReset}
              />
              {tsError ? (
                <p className="auth-warn">人机验证加载失败：{tsError}。请检查网络后点下方按钮重试。</p>
              ) : null}
            </div>
          ) : null}
          <button
            className="btn btn-primary btn-block"
            type="button"
            disabled={busy || !identifierReady() || (turnstileCfg && !tsToken)}
            onClick={sendCode}
          >
            {busy ? '发送中…' : '获取验证码'}
          </button>
        </div>
      ) : null}

      {step === 'code' ? (
        <div className="stack-lg">
          <div className="field">
            <label className="field-label" htmlFor="auth-code">验证码</label>
            <input
              id="auth-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位数字"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              onKeyDown={(event) => { if (event.key === 'Enter') verify(); }}
            />
            <p className="meta">已发送到 {channel === 'phone' ? phone.trim() : email}</p>
          </div>
          <button className="btn btn-primary btn-block" type="button" disabled={busy} onClick={verify}>
            {busy ? '验证中…' : '登录'}
          </button>
          <button
            className="btn btn-ghost btn-block"
            type="button"
            disabled={cooldown > 0}
            onClick={sendCode}
          >
            {cooldown > 0 ? `${cooldown} 秒后可重新发送` : '重新发送'}
          </button>
        </div>
      ) : null}

      {step === 'profile' ? (
        <div className="stack-lg">
          <div className="field">
            <label className="field-label" htmlFor="auth-nickname">昵称（{nickname.length}/16）</label>
            <input
              id="auth-nickname"
              className="input"
              maxLength={16}
              placeholder="2–16 个字，全站可见"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="auth-school">
              <IconSchool size={14} /> 学校（选定后不可更改）
            </label>
            {schoolsLoaded && schools.length === 0 ? (
              <p className="auth-warn">管理员还没有配置学校名单，暂时无法完成注册。</p>
            ) : (
              <select
                id="auth-school"
                className="select"
                value={school}
                onChange={(event) => setSchool(event.target.value)}
              >
                <option value="">请选择学校</option>
                {schools.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            )}
            <p className="meta">学校会显示在你的主页最前面，并且不能修改，请如实选择。</p>
          </div>

          <div className="field">
            <span className="field-label">头像</span>
            <div className="auth-avatars">
              <button
                type="button"
                className={'auth-avatar' + (avatar === '' ? ' is-active' : '')}
                onClick={() => setAvatar('')}
                aria-label="使用默认头像"
              >
                <Avatar user={{ uuid: email, nickname }} size={44} />
              </button>
              {AVATAR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={'auth-avatar' + (avatar === key ? ' is-active' : '')}
                  onClick={() => setAvatar(key)}
                  aria-label={'头像 ' + key}
                >
                  <Avatar user={{ uuid: email, nickname, avatar: key }} size={44} />
                </button>
              ))}
            </div>
          </div>

          <button
            className="btn btn-primary btn-block"
            type="button"
            disabled={busy || !school || nickname.trim().length < 2}
            onClick={register}
          >
            {busy ? '创建中…' : '完成注册'}
          </button>
          <p className="meta auth-foot"><IconLock size={13} /> 我们不存密码，只有邮箱与你自己填的资料。</p>
        </div>
      ) : null}
    </Sheet>
  );
}

export default AuthSheet;
