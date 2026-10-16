/**
 * 后端 API 客户端（唯一的网络出口）。
 *
 * 约定：
 *   - 所有方法返回解析后的 JSON，失败一律 throw ApiError；
 *   - ApiError.message 是**可以直接 toast 的中文**（优先用服务端下发的 message）；
 *   - 401 login_required 会触发注册进来的登录回调，UI 不需要在每个调用点判断登录态。
 *
 * 为什么不引 axios / react-query：本站前端只有 React 一个依赖，
 * 首屏体积与「零第三方依赖」是这个项目一贯的取舍（见根 README）。
 */

const DEFAULT_TIMEOUT = 12000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryAfter = 0, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.payload = payload;
  }
}

/** 服务端错误码 → 人话。服务端给了 message 时优先用服务端的。 */
const MESSAGES = {
  login_required: '请先登录',
  rate_limited: '操作太快了，歇一会儿再试',
  invalid_email: '邮箱格式不正确',
  invalid_code: '验证码不正确',
  code_expired: '验证码已失效，请重新获取',
  invalid_token: '注册凭证已失效，请重新获取验证码',
  nickname_rejected: '这个昵称不能用，换一个吧',
  nickname_length: '昵称长度不合适',
  nickname_cooldown: '昵称刚改过，过段时间再改',
  invalid_school: '请从列表里选择学校',
  schools_unavailable: '管理员还没有配置学校名单',
  already_registered: '该邮箱已注册，直接登录即可',
  account_banned: '账号已被封禁',
  muted: '账号被禁言，暂时不能发言',
  empty: '内容不能为空',
  too_long: '内容太长了',
  invalid_title: '标题长度不合适',
  invalid_length: '长度不合适',
  not_friends: '只有好友之间才能私信',
  blocked: '对方已经拉黑了你',
  already_friends: '你们已经是好友了',
  self: '不能对自己做这个操作',
  not_found: '内容不存在或已删除',
  unauthorized: '没有权限',
  unknown_action: '不支持的操作'
};

let loginHandler = null;

/** AuthContext 挂载时注册：任何接口返回 login_required 都会叫它去弹登录 */
export function setLoginHandler(fn) {
  loginHandler = typeof fn === 'function' ? fn : null;
}

function describe(status, payload) {
  if (payload && typeof payload.message === 'string' && payload.message) return payload.message;
  if (payload && MESSAGES[payload.error]) return MESSAGES[payload.error];
  if (status === 429) {
    const wait = Number(payload && payload.retryAfter) || 0;
    return wait >= 60 ? `太频繁了，请 ${Math.ceil(wait / 60)} 分钟后再试` : '太频繁了，请稍后再试';
  }
  if (status === 401) return '请先登录';
  if (status === 403) return '没有权限';
  if (status === 404) return '内容不存在';
  if (status >= 500) return '服务器开小差了，稍后再试';
  return '请求失败，请稍后再试';
}

async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT, notifyLogin = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(path, {
      method,
      signal: controller.signal,
      credentials: 'same-origin', // 会话 cookie 走同源，不需要任何 token 管理
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new ApiError('网络有点慢，请重试', { code: 'timeout' });
    }
    throw new ApiError('连接不上服务器', { code: 'offline' });
  }
  clearTimeout(timer);

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.ok) return payload;

  const code = (payload && payload.error) || '';
  const error = new ApiError(describe(res.status, payload), {
    status: res.status,
    code,
    retryAfter: Number((payload && payload.retryAfter) || 0),
    payload
  });

  // 登录态失效：交给 AuthContext 统一处理（弹登录），调用方只需要 catch 后忽略
  if (res.status === 401 && code === 'login_required' && notifyLogin && loginHandler) {
    loginHandler(error);
  }
  throw error;
}

const qs = (params) => {
  const search = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const text = search.toString();
  return text ? '?' + text : '';
};

export const api = {
  site: () => request('/api/site'),
  health: () => request('/api/health'),
  schools: () => request('/api/schools'),
  feedback: (data) => request('/api/feedback', { method: 'POST', body: data }),

  auth: {
    requestCode: (email) => request('/api/auth/code', { method: 'POST', body: { email }, notifyLogin: false }),
    verify: (email, code) => request('/api/auth/verify', { method: 'POST', body: { email, code }, notifyLogin: false }),
    register: (data) => request('/api/auth/register', { method: 'POST', body: data, notifyLogin: false }),
    logout: () => request('/api/auth/logout', { method: 'POST', body: {}, notifyLogin: false }),
    me: () => request('/api/auth/me', { notifyLogin: false })
  },

  me: {
    update: (patch) => request('/api/me', { method: 'PATCH', body: patch })
  },

  users: {
    get: (uuid) => request('/api/users/' + encodeURIComponent(uuid), { notifyLogin: false }),
    block: (uuid) => request('/api/users/' + encodeURIComponent(uuid) + '/block', { method: 'POST', body: {} }),
    unblock: (uuid) => request('/api/users/' + encodeURIComponent(uuid) + '/unblock', { method: 'POST', body: {} })
  },

  posts: {
    list: (params) => request('/api/posts' + qs(params), { notifyLogin: false }),
    create: (data) => request('/api/posts', { method: 'POST', body: data }),
    like: (id) => request('/api/posts/' + encodeURIComponent(id) + '/like', { method: 'POST', body: {} }),
    comments: (id) => request('/api/posts/' + encodeURIComponent(id) + '/comments', { notifyLogin: false }),
    comment: (id, body) => request('/api/posts/' + encodeURIComponent(id) + '/comments', { method: 'POST', body: { body } }),
    report: (postId, reason) => request('/api/reports', { method: 'POST', body: { postId, reason } })
  },

  forum: {
    threads: (params) => request('/api/forum/threads' + qs(params), { notifyLogin: false }),
    createThread: (data) => request('/api/forum/threads', { method: 'POST', body: data }),
    thread: (id) => request('/api/forum/threads/' + encodeURIComponent(id), { notifyLogin: false }),
    reply: (id, body) => request('/api/forum/threads/' + encodeURIComponent(id) + '/replies', { method: 'POST', body: { body } }),
    like: (id) => request('/api/forum/threads/' + encodeURIComponent(id) + '/like', { method: 'POST', body: {} })
  },

  friends: {
    list: () => request('/api/friends'),
    request: (uuid, message) => request('/api/friends/requests', { method: 'POST', body: { uuid, message } }),
    accept: (uuid) => request('/api/friends/requests/' + encodeURIComponent(uuid) + '/accept', { method: 'POST', body: {} }),
    decline: (uuid) => request('/api/friends/requests/' + encodeURIComponent(uuid) + '/decline', { method: 'POST', body: {} }),
    remove: (uuid) => request('/api/friends/' + encodeURIComponent(uuid), { method: 'DELETE' })
  },

  dm: {
    conversations: () => request('/api/dm/conversations'),
    unread: () => request('/api/dm/unread', { notifyLogin: false }),
    thread: (uuid, params) => request('/api/dm/' + encodeURIComponent(uuid) + qs(params)),
    send: (uuid, body) => request('/api/dm/' + encodeURIComponent(uuid), { method: 'POST', body: { body } })
  }
};

export default api;
