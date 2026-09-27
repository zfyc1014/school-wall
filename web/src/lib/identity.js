/**
 * 后台实名的前端客户端。
 *
 * 与 turnstile.js 的分工：
 *   turnstile.js  拿「你不是机器人」的一次性 token
 *   identity.js   拿「我们能把内容追溯到某个已验证手机号」的会话凭据
 *
 * 关键点：发码接口需要先过人机验证（否则它就是个现成的短信轰炸器），
 * 因此 requestIdentityCode 会在需要时先确保 Turnstile 已通过。
 */

const PHONE_KEY = 'od_identity_phone_hint';

/** 读取实名配置（已并入 /api/challenge/config，避免多一次请求） */
export function readIdentityConfig(config) {
  return (config && config.identity) || {
    required: false,
    requireForReads: false,
    verified: true,
    phoneMasked: '',
    consentVersion: 'v1.0',
    codeTtlMinutes: 10,
    resendIntervalSeconds: 60,
    provider: '',
    supportedCountries: ['86', '852'],
  };
}

async function postJSON(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || '操作失败，请稍后再试');
    err.code = data.error || 'failed';
    err.status = res.status;
    err.retryAfter = Number(data.retryAfter) || 0;
    throw err;
  }
  return data;
}

/**
 * 申请验证码。需要时先确保人机验证已通过。
 * @param {object} options
 * @param {string} options.phone
 * @param {() => Promise<boolean>} options.ensureChallenge 确保 Turnstile 已通过的兜底函数
 */
export async function requestIdentityCode({ phone, ensureChallenge }) {
  if (ensureChallenge) {
    const ok = await ensureChallenge();
    if (!ok) {
      const err = new Error('需要先完成人机验证');
      err.code = 'challenge_cancelled';
      throw err;
    }
  }
  const data = await postJSON('/api/identity/request-code', { phone });
  rememberPhone(phone);
  return data;
}

/** 校验验证码，成功后服务端会下发实名会话 cookie */
export async function verifyIdentityCode({ phone, code, consent }) {
  const data = await postJSON('/api/identity/verify', { phone, code, consent });
  forgetPhone();
  return data;
}

export async function clearIdentitySession() {
  try {
    await fetch('/api/identity/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* 本地状态照常清空 */
  }
}

/* ── 手机号的本地小提示（只存用户自己输入的号码，方便重试；不存验证码） ── */

export function rememberPhone(phone) {
  try { window.localStorage.setItem(PHONE_KEY, String(phone)); } catch { /* ignore */ }
}

export function recallPhone() {
  try { return window.localStorage.getItem(PHONE_KEY) || ''; } catch { return ''; }
}

export function forgetPhone() {
  try { window.localStorage.removeItem(PHONE_KEY); } catch { /* ignore */ }
}
