import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  EMPTY_GATE_CONFIG,
  GATE_SHEET_ID,
  fetchGateConfig,
  requestGateChallenge,
  submitGate,
  clearGateSession,
} from '../lib/gate.js';
import { mergeBeta } from '../lib/beta.js';
import { useSheet } from '../hooks/useSheet.js';
import { IconClose } from '../components/icons.jsx';

/**
 * 内测门禁状态机（取代原 ChallengeContext + IdentityContext）。
 *
 * 流程：
 *   1. 拉 `GET /api/gate/config`（是否强制、是否已通过、内测版元信息）
 *   2. 未通过且强制 → 弹层：用户填邀请码 + 答一道本地题
 *   3. `POST /api/gate/verify` → 服务端校验后签发 HttpOnly 会话 cookie
 *   4. 会话有效期内（默认 12 小时）所有写操作直接放行，不再重复答题
 *
 * 两条硬规则：
 *   - **拿不到配置就当作未启用**：本地演示模式 / 后端未起时绝不弹层挡人
 *     （`npm run smoke` 跑的就是这条路径），服务端仍有独立闸门；
 *   - `ensureVerified()` 是写操作前的兜底：入口没走过、会话过期时，
 *     数据层收到 `403 gate_required` 会调用它，用户完成后自动重试原请求。
 *
 * 为什么没有第三个参数（sitekey 之类）：自托管门禁不需要任何第三方密钥，
 * 题目答案只存在服务端内存里，前端只拿到题面。
 */

const GateContext = createContext(null);

export function useGate() {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error('useGate 必须在 GateProvider 内使用');
  return ctx;
}

export function GateProvider({ children }) {
  const [config, setConfig] = useState(EMPTY_GATE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(true);
  const [open, setOpen] = useState(false);
  const [challenge, setChallenge] = useState(null); // { id, items:[{q}], expiresAt }
  const [code, setCode] = useState('');
  const [answers, setAnswers] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const waiters = useRef([]);
  const liveRef = useRef(true);

  const required = Boolean(config.required);
  const beta = useMemo(() => mergeBeta(config.beta), [config.beta]);

  /* ── 读取配置 ─────────────────────────────────────────────── */
  const refresh = useCallback(async () => {
    try {
      const data = await fetchGateConfig();
      if (!liveRef.current) return null;
      setConfig((prev) => ({ ...prev, ...data }));
      setVerified(data.enabled ? Boolean(data.verified) : true);
      return data;
    } catch {
      // 后端不可用（本地演示 / 静态预览）：按「不启用」处理，绝不挡人。
      if (!liveRef.current) return null;
      setConfig(EMPTY_GATE_CONFIG);
      setVerified(true);
      return null;
    } finally {
      if (liveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  /* ── 取题（一次性挑战） ───────────────────────────────────── */
  const loadChallenge = useCallback(async () => {
    setError('');
    try {
      const data = await requestGateChallenge();
      if (!liveRef.current) return;
      if (!data || data.enabled === false) {
        // 服务端说门禁没开：直接放行，别让用户对着一道假题发呆
        setChallenge(null);
        setVerified(true);
        setOpen(false);
        return;
      }
      setChallenge(data);
      setAnswers(new Array((data.items || []).length).fill(''));
    } catch (err) {
      if (!liveRef.current) return;
      setChallenge(null);
      setError(err?.message || '获取验证题目失败，请稍后重试');
    }
  }, []);

  // 首次拉配置；需要验证时自动弹出闸门（仅在后端明确要求时）
  useEffect(() => {
    refresh().then((data) => {
      if (!liveRef.current) return;
      if (data?.required && !data.verified) {
        setOpen(true);
        loadChallenge();
      }
    });
  }, [refresh, loadChallenge]);

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

  /**
   * 兜底入口：调用后保证「要么已验证，要么用户明确放弃」。
   * @returns {Promise<boolean>}
   */
  const ensureVerified = useCallback(() => {
    if (!required || verified) return Promise.resolve(true);
    setOpen(true);
    if (!challenge) loadChallenge();
    return new Promise((resolve) => {
      waiters.current.push(resolve);
    });
  }, [required, verified, challenge, loadChallenge]);

  const requestVerification = useCallback(() => {
    if (!required || verified) return Promise.resolve(true);
    return ensureVerified();
  }, [required, verified, ensureVerified]);

  const openSheet = useCallback(() => {
    setOpen(true);
    if (required && !verified && !challenge) loadChallenge();
  }, [required, verified, challenge, loadChallenge]);

  const cancel = useCallback(() => {
    setOpen(false);
    setError('');
    settle(false);
  }, [settle]);

  /* ── 提交 ─────────────────────────────────────────────────── */
  const submit = useCallback(async () => {
    if (submitting) return;

    const needCode = Boolean(config.inviteRequired);
    if (needCode && !code.trim()) {
      setError('请填写内测邀请码');
      return;
    }
    const items = challenge?.items || [];
    if (!challenge || !items.length) {
      setError('验证题目已失效，正在重新获取…');
      loadChallenge();
      return;
    }
    if (answers.some((a) => !String(a || '').trim())) {
      setError('请把每道题都答完');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const result = await submitGate({
        code: code.trim(),
        challengeId: challenge.id,
        answers: answers.map((a) => String(a).trim()),
      });

      if (!result.ok) {
        setError(result.message || '验证未通过，请重试');
        // 题目一次性：答错或过期都必须换一份新的，否则用户会一直撞同一堵墙
        if (result.code === 'challenge_failed' || result.code === 'challenge_expired' || result.remaining === 0) {
          loadChallenge();
        }
        return;
      }

      setVerified(true);
      setOpen(false);
      setCode('');
      setAnswers([]);
      setChallenge(null);
      settle(true);
      refresh();
    } catch (err) {
      setError(err?.message || '验证失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, config.inviteRequired, code, challenge, answers, loadChallenge, settle, refresh]);

  /** 结束本机会话（换人使用同一设备时用） */
  const logout = useCallback(async () => {
    await clearGateSession();
    setVerified(false);
    await refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    config,
    loading,
    required,
    verified,
    open,
    submitting,
    error,
    beta,
    inviteRequired: Boolean(config.inviteRequired),
    challenge,
    code,
    answers,
    setCode,
    setAnswers,
    openSheet,
    ensureVerified,
    requestVerification,
    refresh,
    logout,
    dismiss: cancel,
  }), [
    config, loading, required, verified, open, submitting, error, beta, challenge, code, answers,
    openSheet, ensureVerified, requestVerification, refresh, logout, cancel,
  ]);

  return (
    <GateContext.Provider value={value}>
      {children}
      <GateSheet
        open={open}
        inviteRequired={Boolean(config.inviteRequired)}
        challenge={challenge}
        code={code}
        answers={answers}
        submitting={submitting}
        error={error}
        onCode={setCode}
        onAnswer={(index, next) => {
          setAnswers((prev) => {
            const out = prev.slice();
            out[index] = next;
            return out;
          });
        }}
        onSubmit={submit}
        onReload={loadChallenge}
        onClose={cancel}
      />
    </GateContext.Provider>
  );
}

/** 入口闸门 / 重新验证弹层 */
function GateSheet({
  open, inviteRequired, challenge, code, answers,
  submitting, error, onCode, onAnswer, onSubmit, onReload, onClose,
}) {
  const { ref, entered } = useSheet({ open, onClose });
  const items = challenge?.items || [];

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id={GATE_SHEET_ID}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="gate-title"
    >
      <div className="sheet gate-sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id="gate-title">内测验证</h2>
            <p className="meta" style={{ marginTop: 4 }}>
              浏览不受限；发布、评论、举报前需要邀请码，并答一道本地题目。
            </p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        {inviteRequired && (
          <div className="field">
            <div className="field-label">
              <span>内测邀请码</span>
              <span className="meta">向邀请你的人索取</span>
            </div>
            <input
              id="gate-code"
              className="text-input"
              type="text"
              data-autofocus
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 BETA-2026-XXXX"
              value={code}
              onChange={(e) => onCode(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <div className="field-label">
            <span>本地验证</span>
            <span className="meta">题目由本站生成，不出网</span>
          </div>

          {items.length ? (
            <div className="gate-items">
              {items.map((item, i) => (
                <label className="gate-item" key={`${challenge.id}-${i}`}>
                  <span className="gate-q">{item.q}</span>
                  <input
                    className="text-input gate-answer"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    data-gate-answer
                    aria-label={`第 ${i + 1} 题答案`}
                    value={answers[i] || ''}
                    onChange={(e) => onAnswer(i, e.target.value)}
                  />
                </label>
              ))}
            </div>
          ) : (
            <p className="meta">正在获取题目…</p>
          )}
        </div>

        {submitting && <p className="meta" aria-live="polite">正在校验…</p>}
        {error && <p className="err">{error}</p>}

        <p className="stamp">
          验证完全在本站完成：不加载任何第三方脚本、不保存原始 IP；
          通过后只签发一个短期会话凭据（HttpOnly，绑定当前网络环境）。
        </p>

        <div className="sheet-actions">
          <button className="btn btn-secondary" type="button" onClick={onReload} disabled={submitting}>
            换一道题
          </button>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            暂不验证，仅浏览
          </button>
          <button
            className="btn btn-primary"
            type="button"
            data-gate-submit
            disabled={submitting}
            onClick={onSubmit}
          >
            {submitting ? '校验中…' : '验证并继续'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { EMPTY_GATE_CONFIG };
