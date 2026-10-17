import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Turnstile } from '../components/Turnstile.jsx';

/**
 * 手机号绑定（登录后的第二通道）。
 *
 * 为什么值得单独一块：手机号是「账号找回」和「用短信登录」的前提，
 * 但它是凭证变更，必须**先验证码确认这个号码属于你**，不能像昵称一样随手改。
 *
 * 发码同样要过 Turnstile（action=bind_phone）：短信每条都是真金白银，
 * 「用户已登录」不等于「不是脚本」。
 */

/** +8613800138000 → +86138****8000 */
function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 8) return s;
  return s.slice(0, s.length - 8) + '****' + s.slice(-4);
}

export function PhoneBind() {
  const { user, updateUser } = useAuth();
  const toast = useToast();
  const [site, setSite] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone'); // phone → code
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.site().then((data) => { if (alive) setSite(data); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const tsCfg = site && site.turnstile ? site.turnstile : null;
  // 短信通道没就绪时后端会 503，这里提前把入口关掉，别让用户点了才知道
  const smsReady = Boolean(site && site.features && site.features.phoneLogin);

  const sendCode = async () => {
    const value = phone.trim();
    if (!value) return;
    if (tsCfg && !token) {
      toast('请先完成人机验证');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const result = await api.me.bindPhoneCode(value, token || undefined);
      setStage('code');
      if (result && result.devCode) {
        setCode(result.devCode);
        toast('开发模式：验证码已自动填入');
      } else {
        toast(result && result.delivered ? '验证码已发送' : '验证码已生成，但短信未能发出（见服务端日志）');
      }
    } catch (e) {
      setErr(e.message || '发送失败');
    } finally {
      setBusy(false);
      setToken('');
      setReset((n) => n + 1); // token 一次性，失败也要换新的
    }
  };

  const verify = async () => {
    if (code.trim().length !== 6) {
      toast('请输入 6 位验证码');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const result = await api.me.bindPhoneVerify(phone.trim(), code.trim());
      if (result && result.user) updateUser(result.user);
      toast('手机号已绑定');
      setStage('phone');
      setPhone('');
      setCode('');
    } catch (e) {
      setErr(e.message || '绑定失败');
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    setBusy(true);
    try {
      const result = await api.me.unbindPhone();
      if (result && result.user) updateUser(result.user);
      toast('已解绑手机号');
    } catch (e) {
      toast(e.message || '解绑失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>手机号</strong>
        <span className="meta">{user && user.phoneVerified ? '已验证' : '未绑定'}</span>
      </div>

      {user && user.phone ? (
        <>
          <p className="meta" style={{ marginTop: 8 }}>
            已绑定 <span className="mono">{maskPhone(user.phone)}</span>，可用于短信验证码登录。
          </p>
          <button
            className="btn btn-ghost btn-block"
            style={{ marginTop: 12 }}
            type="button"
            disabled={busy}
            onClick={unbind}
          >
            {busy ? '处理中…' : '解绑手机号'}
          </button>
        </>
      ) : !smsReady ? (
        <p className="meta" style={{ marginTop: 8 }}>
          短信通道未启用：管理员配置 Brevo 短信后，这里才能绑定手机号。
        </p>
      ) : stage === 'phone' ? (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="bind-phone">手机号</label>
            <input
              id="bind-phone"
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="13800138000"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <p className="meta">国内号码直接填 11 位；境外号码请带国家码（+86…）。</p>
          </div>
          {tsCfg ? (
            <div className="turnstile-block" style={{ marginTop: 12 }}>
              <Turnstile
                siteKey={tsCfg.siteKey}
                action="bind_phone"
                onToken={(value) => setToken(value)}
                onError={(msg) => setErr(msg)}
                resetSignal={reset}
              />
            </div>
          ) : null}
          {err ? <p className="auth-warn">{err}</p> : null}
          <button
            className="btn btn-primary btn-block"
            style={{ marginTop: 16 }}
            type="button"
            disabled={busy || !phone.trim() || (tsCfg && !token)}
            onClick={sendCode}
          >
            {busy ? '发送中…' : '发送验证码'}
          </button>
        </>
      ) : (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="bind-code">验证码</label>
            <input
              id="bind-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位数字"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
            <p className="meta">已发送到 {phone.trim()}</p>
          </div>
          {err ? <p className="auth-warn">{err}</p> : null}
          <button
            className="btn btn-primary btn-block"
            style={{ marginTop: 16 }}
            type="button"
            disabled={busy}
            onClick={verify}
          >
            {busy ? '绑定中…' : '确认绑定'}
          </button>
          <button
            className="btn btn-ghost btn-block"
            style={{ marginTop: 8 }}
            type="button"
            disabled={busy}
            onClick={() => { setStage('phone'); setCode(''); setErr(''); }}
          >
            换个号码
          </button>
        </>
      )}
    </section>
  );
}

export default PhoneBind;
