/**
 * 内测门禁客户端。
 *
 * 与后端 `server/src/gate.js` 的分工：
 *   - 这里只负责「取配置 / 取题目 / 提交邀请码与答案 / 结束会话」；
 *   - 真正的判定始终在服务端：一次性挑战的答案只存在服务端内存里，
 *     通过后签发 HttpOnly 会话 cookie，前端拿不到、也伪造不了。
 *
 * 为什么不用任何第三方脚本：内测版把 Turnstile 换成了自托管校验，
 * 页面因此不再加载任何外部资源 —— CSP 只需 'self'，也不再有「验证服务不可达」
 * 这种失败模式（整个校验在本进程内完成）。
 *
 * 容错原则：**拿不到配置就当作「未启用」**。
 * 宁可少一层门禁，也不要让整站在后端不可用时不可用（本地演示模式就依赖这一点）；
 * 服务端仍然有独立闸门，不依赖前端这个判断。
 */

/** 无后端 / 门禁关闭时的默认配置：required=false，前端不弹层 */
export const EMPTY_GATE_CONFIG = {
  enabled: false,
  required: false,
  verified: true,
  inviteRequired: true,
  sessionTtl: 43200,
  challengeTtl: 600,
  challengeItems: 2,
  beta: null,
  error: '',
};

/** 弹层 DOM id：端到端测试用它断言闸门是否出现 */
export const GATE_SHEET_ID = 'gate';

/** 把后端的错误码翻译成用户能看懂的话（与 data/adapters.js 的口径保持一致） */
export const GATE_ERRORS = {
  invalid_code: '内测邀请码不正确',
  challenge_failed: '答案不正确，请重试',
  challenge_expired: '验证已过期，请重新获取题目',
  rate_limited: '尝试过于频繁，请稍后再试',
  gate_required: '请先通过内测验证',
};

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * @returns {Promise<{ok: boolean, status: number, data: any, code: string, message: string}>}
 */
async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // 同源部署：会话 cookie 存在这里，不需要 CORS
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { ok: false, status: 0, data: {}, code: 'unreachable', message: '无法连接后端服务' };
  }

  const data = await readJsonSafe(res);
  const code = String(data?.error || '');
  return {
    ok: res.ok,
    status: res.status,
    data,
    code,
    message: data?.message || GATE_ERRORS[code] || '请求失败，请稍后再试',
  };
}

/** 读取门禁 + 内测版配置（公开接口，不含任何机密） */
export async function fetchGateConfig({ signal } = {}) {
  const res = await request('/api/gate/config', { signal });
  if (!res.ok) throw Object.assign(new Error(res.message), { code: res.code, status: res.status });
  return res.data;
}

/** 取一份一次性挑战题目；门禁关闭时返回 { enabled: false } */
export async function requestGateChallenge({ signal } = {}) {
  const res = await request('/api/gate/challenge', { method: 'POST', signal });
  if (!res.ok) throw Object.assign(new Error(res.message), { code: res.code, status: res.status });
  return res.data;
}

/**
 * 提交邀请码 + 挑战答案。
 * @returns {Promise<{ok: boolean, code: string, message: string, remaining?: number, expiresIn?: number}>}
 */
export async function submitGate({ code, challengeId, answers, signal } = {}) {
  const res = await request('/api/gate/verify', {
    method: 'POST',
    signal,
    body: { code, challengeId, answers },
  });
  return {
    ok: res.ok,
    code: res.code,
    message: res.message,
    remaining: res.data?.remaining,
    expiresIn: res.data?.expiresIn,
  };
}

/** 主动结束会话（换人使用同一设备时用；不关心失败） */
export async function clearGateSession() {
  try {
    await request('/api/gate/logout', { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}
