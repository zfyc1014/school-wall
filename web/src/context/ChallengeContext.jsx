import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Turnstile } from '../components/Turnstile.jsx';
import { createChallengeSession, fetchChallengeConfig, TEST_MODE, TEST_TOKEN } from '../lib/turnstile.js';
import { useSheet } from '../hooks/useSheet.js';
import { IconClose } from '../components/icons.jsx';

/**
 * 人机验证状态机。
 *
 * 流程：
 *   1. 拉 /api/challenge/config（拿到 siteKey、是否必须验证、当前是否已验证）
 *   2. 未验证且必须验证 → 弹出验证弹层，用户完成托管挑战拿到一次性 token
 *   3. POST /api/challenge/session → 服务端 siteverify 通过后签发会话 cookie
 *   4. 会话有效期内，所有写操作直接放行（不再往返 Cloudflare）
 *
 * 为什么用「一次验证 + 短期会话」而不是每次提交都验：
 *   每次互动都出网校验会给低配 VPS 增加不必要的等待与出网依赖；
 *   Turnstile token 本身也是一次性的，无法复用。
 *
 * ensureVerified() 是给「写操作前兜底」用的：入口闸门没走过（比如直接深链接、
 * 会话过期）时，业务代码调用它会拿到一个可用的凭据。
 */

const ChallengeContext = createContext(null);

export function useChallenge() {
  const ctx = useContext(ChallengeContext);
  if (!ctx) throw new Error('useChallenge 必须在 ChallengeProvider 内使用');
  return ctx;
}

const EMPTY_CONFIG = {
  enabled: false,
  required: false,
  verified: true,
  siteKey: '',
  sessionTtl: 1800,
  error: '',
};

export function ChallengeProvider({ children }) {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(true);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const tokenRef = useRef('');
  const waiters = useRef([]);
  const [widgetKey, setWidgetKey] = useState(0); // 主动重置 widget 用

  const required = Boolean(config.required);

  /* ── 读取配置 ─────────────────────────────────────────────── */
  const refresh = useCallback(async () => {
    try {
      const data = await fetchChallengeConfig();
      setConfig((prev) => ({ ...prev, ...data }));
      setVerified(data.enabled ? Boolean(data.verified) : true);
      return data;
    } catch (err) {
      // 拿不到配置时按「不启用」处理：宁可少一层验证，也不要让整站不可用。
      // 服务端仍然有独立闸门，不依赖前端这个判断。
      setConfig(EMPTY_CONFIG);
      setVerified(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    refresh().then((data) => {
      if (alive && data?.required && !data.verified) setOpen(true);
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 会话到期前后台重新确认（页面回到前台时也查一次，避免长时间挂后台后失效）
  useEffect(() => {
    if (!required) return undefined;
    const tick = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [required, refresh]);

  /* ── 等待者队列：ensureVerified 的 Promise 出口 ───────────── */
  const settle = useCallback((ok) => {
    const list = waiters.current;
    waiters.current = [];
    list.forEach((resolve) => resolve(ok));
  }, []);

  const handleToken = useCallback(async (token) => {
    tokenRef.current = token || '';
    if (!token) return;

    setSubmitting(true);
    setError('');
    try {
      await createChallengeSession(token);
      setVerified(true);
      setOpen(false);
      settle(true);
      // token 已被服务端消费（一次性），重置以便下次需要时重新获取。
      // 测试模式下重新放一个假 token，让后续写请求（发布/点赞）也能带上凭据。
      tokenRef.current = TEST_MODE ? TEST_TOKEN : '';
      setWidgetKey((k) => k + 1);
    } catch (err) {
      setVerified(false);
      setError(err?.message || '人机验证未通过，请重试');
      setWidgetKey((k) => k + 1); // 让 widget 重新生成 token
      // 刻意不 settle：弹层保持打开，用户重试成功后同一个 ensureVerified()
      // 的 Promise 才会兑现 —— 这样业务侧的「验证后自动重试原请求」不会丢。
    } finally {
      setSubmitting(false);
    }
  }, [settle]);

  /* ── 测试模式：跳过 widget，直接用假 token 走完整验证流程 ──── */
  useEffect(() => {
    if (!TEST_MODE || !required || verified || submitting) return;
    handleToken(TEST_TOKEN);
  }, [required, verified, submitting, handleToken]);

  const handleError = useCallback((message) => {
    setError(message || '人机验证加载失败');
  }, []);

  /**
   * 兜底入口：调用后保证「要么已验证，要么用户明确放弃」。
   * @returns {Promise<boolean>}
   */
  const ensureVerified = useCallback(() => {
    if (!required) return Promise.resolve(true);
    if (verified) return Promise.resolve(true);
    if (tokenRef.current) return Promise.resolve(true); // 已有未消费的 token
    setOpen(true);
    return new Promise((resolve) => {
      waiters.current.push(resolve);
    });
  }, [required, verified]);

  const requestVerification = useCallback(() => {
    if (!required) return Promise.resolve(true);
    return ensureVerified();
  }, [required, ensureVerified]);

  const cancel = useCallback(() => {
    setOpen(false);
    settle(false);
  }, [settle]);

  const value = useMemo(() => ({
    config,
    loading,
    required,
    verified,
    open,
    submitting,
    error,
    siteKey: config.siteKey,
    ensureVerified,
    requestVerification,
    refresh,
    dismiss: cancel,
  }), [config, loading, required, verified, open, submitting, error, ensureVerified, requestVerification, refresh, cancel]);

  return (
    <ChallengeContext.Provider value={value}>
      {children}
      <ChallengeSheet
        open={open}
        siteKey={config.siteKey}
        widgetKey={widgetKey}
        submitting={submitting}
        error={error}
        onToken={handleToken}
        onError={handleError}
        onClose={cancel}
      />
    </ChallengeContext.Provider>
  );
}

/** 入口闸门 / 重新验证弹层 */
function ChallengeSheet({ open, siteKey, widgetKey, submitting, error, onToken, onError, onClose }) {
  const { ref, entered } = useSheet({ open, onClose });

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="challenge"
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="challenge-title"
    >
      <div className="sheet challenge-sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id="challenge-title">先确认你是真人</h2>
            <p className="meta" style={{ marginTop: 4 }}>
              校园匿名社区需要防止机器人刷屏，验证一次即可正常浏览与发布。
            </p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="turnstile-box">
          {siteKey ? (
            <Turnstile
              key={widgetKey}
              siteKey={siteKey}
              onToken={onToken}
              onError={onError}
              autoResetOnExpire={false}
            />
          ) : (
            <p className="meta">正在获取验证配置…</p>
          )}
        </div>

        {submitting && <p className="meta" aria-live="polite">正在校验…</p>}
        {error && <p className="err">{error}</p>}

        <p className="stamp">
          本验证由 Cloudflare Turnstile 提供，不会读取你的账号信息；
          通过后本服务会签发一个短时会话凭据，不保存原始 IP。
        </p>

        <div className="sheet-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            暂不验证，仅浏览
          </button>
        </div>
      </div>
    </div>
  );
}

export { EMPTY_CONFIG };
