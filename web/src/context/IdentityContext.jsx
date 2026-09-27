import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSheet } from '../hooks/useSheet.js';
import { IconClose } from '../components/icons.jsx';
import {
  clearIdentitySession,
  readIdentityConfig,
  recallPhone,
  rememberPhone,
  requestIdentityCode,
  verifyIdentityCode,
} from '../lib/identity.js';
import { fetchChallengeConfig } from '../lib/turnstile.js';

/**
 * 后台实名状态机（手机号 + 短信验证码）。
 *
 * 与 ChallengeContext 的关系：
 *   两个闸门是「且」的关系 —— 人机验证回答「你不是脚本」，实名回答「出事时能找到你」。
 *   发短信前必须先过人机验证，因此这里会调用 challenge.ensureVerified 兜底。
 *
 * 产品取舍：**不拦截阅读**。表白墙读多写少，把浏览挡在手机号后面会显著伤害可用性；
 * 而真正有法律风险的是「发布」，所以闸门设在写入路径上（服务端同样强制）。
 */

const IdentityContext = createContext(null);

export function useIdentity() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity 必须在 IdentityProvider 内使用');
  return ctx;
}

/**
 * @param {object} props
 * @param {(config: any) => void} props.onConfig  配置变化时上报（方便 debug 探针与 UI）
 * @param {() => Promise<boolean>} props.ensureChallenge 确保 Turnstile 已通过
 */
export function IdentityProvider({ children, onConfig, ensureChallenge }) {
  const [config, setConfig] = useState(readIdentityConfig(null));
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('phone'); // phone | code
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [masked, setMasked] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const waiters = useRef([]);
  const challengeRef = useRef(ensureChallenge);
  challengeRef.current = ensureChallenge;

  const required = Boolean(config.required);
  const verified = Boolean(config.verified);

  /* ── 配置读取（复用 challenge 配置接口，少一次请求） ───────── */
  const refresh = useCallback(async () => {
    try {
      const data = await fetchChallengeConfig();
      const next = readIdentityConfig(data);
      setConfig(next);
      onConfig?.(next);
      return next;
    } catch {
      // 拿不到配置时按「不需要实名」处理：服务端仍会拦，前端不因此卡死页面
      const fallback = readIdentityConfig(null);
      setConfig(fallback);
      onConfig?.(fallback);
      return fallback;
    } finally {
      setLoading(false);
    }
  }, [onConfig]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* ── 倒计时（重发间隔） ───────────────────────────────────── */
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  /* ── 等待者队列 ───────────────────────────────────────────── */
  const settle = useCallback((ok) => {
    const list = waiters.current;
    waiters.current = [];
    list.forEach((resolve) => resolve(ok));
  }, []);

  // 配置刷新后发现已验证，就把挂起的等待者放行（例如用户在另一个标签页完成了验证）
  useEffect(() => {
    if (verified && waiters.current.length) settle(true);
  }, [verified, settle]);

  /* ── 动作 ─────────────────────────────────────────────────── */

  const openSheet = useCallback(() => {
    setStep('phone');
    setCode('');
    setError('');
    setPhone((prev) => prev || recallPhone());
    setOpen(true);
  }, []);

  const requestCode = useCallback(async () => {
    const value = phone.trim();
    setError('');
    setSending(true);
    try {
      const data = await requestIdentityCode({
        phone: value,
        ensureChallenge: challengeRef.current,
      });
      rememberPhone(value);
      setMasked(data.masked || '');
      setStep('code');
      setCooldown(Number(data.retryAfter) || Number(config.resendIntervalSeconds) || 60);
    } catch (err) {
      setError(err?.message || '验证码发送失败，请稍后重试');
      if (err?.retryAfter) setCooldown(err.retryAfter);
    } finally {
      setSending(false);
    }
  }, [phone, config.resendIntervalSeconds]);

  const submitCode = useCallback(async () => {
    setError('');
    setVerifying(true);
    try {
      const data = await verifyIdentityCode({ phone: phone.trim(), code: code.trim(), consent });
      setConfig((prev) => ({
        ...prev,
        verified: true,
        phoneMasked: data.phoneMasked || prev.phoneMasked,
      }));
      onConfig?.({ ...config, verified: true, phoneMasked: data.phoneMasked });
      setOpen(false);
      settle(true);
      return true;
    } catch (err) {
      setError(err?.message || '验证失败，请重试');
      setCode('');
      return false;
    } finally {
      setVerifying(false);
    }
  }, [phone, code, consent, config, onConfig, settle]);

  const cancel = useCallback(() => {
    setOpen(false);
    settle(false);
  }, [settle]);

  const logout = useCallback(async () => {
    await clearIdentitySession();
    setConfig((prev) => ({ ...prev, verified: false, phoneMasked: '' }));
    setPhone('');
    setCode('');
    setConsent(false);
    setStep('phone');
    onConfig?.({ ...config, verified: false, phoneMasked: '' });
  }, [config, onConfig]);

  /**
   * 写操作前的兜底：要么已实名，要么用户明确放弃。
   * @returns {Promise<boolean>}
   */
  const ensureVerified = useCallback(() => {
    if (!required) return Promise.resolve(true);
    if (verified) return Promise.resolve(true);
    openSheet();
    return new Promise((resolve) => {
      waiters.current.push(resolve);
    });
  }, [required, verified, openSheet]);

  const value = useMemo(() => ({
    config,
    loading,
    required,
    verified: required ? verified : true,
    phoneMasked: config.phoneMasked || '',
    open,
    step,
    phone,
    code,
    consent,
    masked,
    error,
    sending,
    verifying,
    cooldown,
    setPhone,
    setCode,
    setConsent,
    setStep,
    setError,
    openSheet,
    requestCode,
    submitCode,
    cancel,
    logout,
    refresh,
    ensureVerified,
  }), [
    config, loading, required, verified, open, step, phone, code, consent, masked,
    error, sending, verifying, cooldown, openSheet, requestCode, submitCode, cancel,
    logout, refresh, ensureVerified,
  ]);

  return (
    <IdentityContext.Provider value={value}>
      {children}
      <IdentitySheet />
    </IdentityContext.Provider>
  );
}

/** 实名弹层（两步：填号码 → 填验证码） */
function IdentitySheet() {
  const id = useIdentity();
  const { ref, entered } = useSheet({ open: id.open, onClose: id.cancel });
  const canSubmitPhone = id.phone.trim().length >= 8 && !id.sending && id.cooldown === 0;
  const canSubmitCode = id.code.trim().length === 6 && id.consent && !id.verifying;

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="identity"
      role="dialog"
      aria-modal="true"
      aria-hidden={!id.open}
      aria-labelledby="identity-title"
    >
      <div className="sheet identity-sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id="identity-title">实名验证（前台仍匿名）</h2>
            <p className="meta" style={{ marginTop: 4 }}>
              发布内容前需验证手机号；墙上不会展示你的号码
            </p>
          </div>
          <button className="icon-btn" type="button" onClick={id.cancel} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        {id.step === 'phone' ? (
          <>
            <div className="field">
              <div className="field-label">
                <span>手机号</span>
                <span className="meta">支持中国大陆 / 香港</span>
              </div>
              <input
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                data-autofocus
                placeholder="例如 13800138000 或 +852 9123 4567"
                value={id.phone}
                onChange={(e) => id.setPhone(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmitPhone) id.requestCode(); }}
              />
            </div>

            <div className="notice">
              <strong>为什么要手机号</strong>
              <p>
                前台展示始终是匿名的，但平台必须按法律规定收集并验证发布者的身份标识，
                以便在出现违法内容时配合核查。<strong>匿名不等于免责。</strong>
              </p>
              <p>
                我们只保存手机号的<strong>不可逆哈希</strong>与脱敏形式（如 138****8000），
                不保存明文号码；验证码只用于本次验证，不会用于营销。
              </p>
            </div>

            {id.error && <p className="err">{id.error}</p>}

            <div className="sheet-actions">
              <button className="btn btn-secondary" type="button" onClick={id.cancel}>暂不验证</button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canSubmitPhone}
                onClick={id.requestCode}
              >
                {id.sending ? '发送中…' : '获取验证码'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <div className="field-label">
                <span>短信验证码</span>
                <span className="meta">
                  已发送至 {id.masked || id.phone}（{id.config.codeTtlMinutes} 分钟内有效）
                </span>
              </div>
              <input
                className="input code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                data-autofocus
                placeholder="6 位数字"
                value={id.code}
                onChange={(e) => id.setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmitCode) id.submitCode(); }}
              />
            </div>

            <label className="agree">
              <input
                type="checkbox"
                checked={id.consent}
                onChange={(e) => id.setConsent(e.target.checked)}
              />
              <span>
                我已阅读并同意《实名与隐私告知》（{id.config.consentVersion}）：平台会为内容审核与
                依法配合调查之目的处理我的手机号，仅保存不可逆哈希；我承诺不发布违法内容，
                并理解匿名不代表免除责任。
              </span>
            </label>

            {id.error && <p className="err">{id.error}</p>}

            <div className="sheet-actions">
              <button className="btn btn-ghost" type="button" onClick={() => { id.setStep('phone'); id.setError(''); }}>
                换个号码
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={id.cooldown > 0 || id.sending}
                onClick={id.requestCode}
              >
                {id.cooldown > 0 ? `${id.cooldown}s 后可重发` : '重新发送'}
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canSubmitCode}
                onClick={id.submitCode}
              >
                {id.verifying ? '验证中…' : '完成验证'}
              </button>
            </div>

            {id.config.provider === 'log' && (
              <p className="stamp">当前为开发模式（短信通道 log）：验证码只写服务端日志，不会真的发短信。</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
