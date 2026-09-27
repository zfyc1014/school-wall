/**
 * Cloudflare Turnstile 客户端。
 *
 * 设计要点：
 *   - **不引入 npm 依赖**，只按官方方式动态加载 api.js，并用显式 render 控制生命周期；
 *   - token 是**一次性**的（5 分钟过期），所以每次提交前用 takeToken() 取；
 *     取不到就重置 widget 让用户重新验证；
 *   - widget 只负责「拿到 token」。真正的判定在服务端：cookie 会话 + siteverify。
 *     前端禁用按钮只是 UX，绕过它也没用。
 */

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

/**
 * 自动化测试用的确定性 token。
 *
 * 为什么需要它：无头浏览器会被 Cloudflare 判定为机器人，widget 永远拿不到 token，
 * 于是「验证之后一切是否真的解锁」这件事在 CI 里无法验证。
 * 打开 VITE_CHALLENGE_TEST_MODE=1 后，前端会跳过 widget 直接使用这个假 token
 * （配合服务端 Cloudflare 官方测试密钥，siteverify 会返回成功）。
 *
 * 这个开关**只在前端构建期**生效，生产构建不设置即为关闭；
 * 而且服务端仍会正常校验 —— 生产密钥会拒绝这个 dummy token。
 */
export const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const TEST_MODE = String(import.meta.env.VITE_CHALLENGE_TEST_MODE || '') === '1';

let loader = null;

/** 幂等加载脚本（多个组件同时挂载也只加载一次） */
export function loadTurnstile() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const done = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile 未就绪')));

    if (existing) {
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile 脚本加载失败')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = done;
    script.onerror = () => {
      loader = null;
      reject(new Error('Turnstile 脚本加载失败，请检查网络或 CSP'));
    };
    document.head.appendChild(script);
  });

  return loader;
}

/** 取服务端下发的人机验证配置 */
export async function fetchChallengeConfig({ signal } = {}) {
  const res = await fetch('/api/challenge/config', { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error('无法读取人机验证配置');
  return res.json();
}

/** 用一次性 token 换服务端会话 cookie */
export async function createChallengeSession(token, { signal } = {}) {
  const res = await fetch('/api/challenge/session', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || '人机验证未通过');
    err.code = data.error || 'verify_failed';
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function clearChallengeSession() {
  try {
    await fetch('/api/challenge/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* 忽略：本地状态照常清空 */
  }
}
