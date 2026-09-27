/**
 * 数据源适配层（ports & adapters）。
 *
 * 两种适配器实现同一组方法，UI 完全不需要知道自己连的是谁：
 *   - httpAdapter  : 对接 server/ 的 /api（先审后发、按 IP 哈希限流）
 *   - localAdapter : localStorage 演示数据，保证离线/无后端也能完整走通交互
 *
 * 模式（VITE_DATA_MODE，可用 localStorage「od_biaobai_mode_v1」覆盖）：
 *   auto  — 先探测 /api/health，可用走 http，失败回落 local 并在页脚提示（默认）
 *   api   — 强制 http，探测失败即报错，不静默回落
 *   local — 只用 local，完全不请求后端
 */
import { PAGE_SIZE } from '../lib/types.js';
import { seedPosts } from '../lib/seed.js';
import { STORE_KEY, MODE_KEY, readJSON, writeJSON } from '../lib/storage.js';

/**
 * 人机验证挂载点。
 *
 * Provider 挂载时把「确保已通过验证」的实现注册进来，写操作在收到
 * 403 challenge_required 时会调用它 —— 用户完成验证后自动重试一次，
 * 不需要每个调用点都写一遍验证逻辑。
 */
let ensureChallengeReady = null;

export function setChallengeResolver(fn) {
  ensureChallengeReady = typeof fn === 'function' ? fn : null;
}

/**
 * 实名验证的挂载点。与 challenge 同理：写请求收到 403 identity_required 时，
 * 交给 Provider 拉起实名弹层，完成后自动重试原请求。
 */
let ensureIdentityReady = null;

export function setIdentityResolver(fn) {
  ensureIdentityReady = typeof fn === 'function' ? fn : null;
}

/**
 * 待用的一次性 Turnstile token 暂存位。
 *
 * 为什么放这里而不是逐层传参：页面上可能有多个 widget（入口弹层、发布抽屉），
 * 任意一个产出的 token 都可以用于「下一次写请求」。写请求发生时把它取走并清空，
 * 因为 token 是一次性的（5 分钟过期、只能用一次）。
 */
let pendingChallengeToken = '';

export function setPendingChallengeToken(token) {
  pendingChallengeToken = token || '';
}

export function takePendingChallengeToken() {
  const token = pendingChallengeToken;
  pendingChallengeToken = '';
  return token;
}

/** 生成器对象 → 普通数组（兼容老打包目标，不依赖 Object.fromEntries） */
function headersToObject(headers) {
  const out = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

/* ─────────────────────────── HTTP 适配器 ─────────────────────────── */

export class ApiError extends Error {
  constructor(message, { status = 0, retryAfter = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** 把后端的错误码翻译成用户能看懂的话（不泄露内部细节） */
function describeError(status, payload) {
  if (status === 429) {
    const wait = Number(payload?.retryAfter) || 0;
    const mins = wait >= 60 ? `${Math.ceil(wait / 60)} 分钟` : `${wait || 1} 秒`;
    return `操作过于频繁，请 ${mins}后再试`;
  }
  if (status === 400) return '内容不符合发布要求，请检查分类与字数';
  if (status === 403) return '请先完成人机验证';
  if (status === 404) return '这条内容已不存在或尚未公开';
  if (status === 503) return '验证服务暂时不可用，请稍后重试';
  if (status >= 500) return '服务器繁忙，请稍后再试';
  const map = {
    invalid_category: '分类不合法',
    invalid_length: '字数不符合要求',
    rate_limited: '操作过于频繁，请稍后再试',
    not_found: '内容不存在',
    challenge_required: '请先完成人机验证',
    verify_failed: '人机验证未通过，请重试',
    token_expired: '验证已过期，请重新验证',
    verify_unavailable: '验证服务暂时不可用，请稍后重试',
    policy_rejected: '验证来源不被允许',
  };
  return map[payload?.error] || '请求失败，请稍后再试';
}

function createHttpAdapter() {
  /**
   * @param {string} path
   * @param {{method?: string, body?: any, signal?: AbortSignal, timeout?: number}} options
   */
  async function request(path, { method = 'GET', body, signal, timeout = 8000, retried = false } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      // 写操作带上待用的一次性 token（服务端同时接受会话 cookie）
      const headers = {};
      if (body) headers['content-type'] = 'application/json';
      const token = method === 'GET' ? '' : takePendingChallengeToken();
      if (token) headers['cf-turnstile-response'] = token;

      res = await fetch(path, {
        method,
        signal: controller.signal,
        // 同源部署下带上会话 cookie（人机验证通过后的凭据就存在这里）
        credentials: 'same-origin',
        headers: Object.keys(headers).length ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err; // 调用方主动取消
      if (err?.name === 'AbortError') {
        throw new ApiError('后端响应超时', { status: 0, code: 'timeout' });
      }
      throw new ApiError('无法连接后端服务', { status: 0, code: 'unreachable' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    const payload = await readJsonSafe(res);
    if (!res.ok) {
      const code = String(payload?.error || '');
      // 服务端要求先过人机验证：交给 Provider 处理，通过后精确重试一次
      if (res.status === 403 && code === 'challenge_required' && !retried && ensureChallengeReady) {
        const ready = await ensureChallengeReady();
        if (ready) return request(path, { method, body, signal, timeout, retried: true });
        throw new ApiError('需要完成人机验证后才能继续', { status: 403, code: 'challenge_cancelled' });
      }
      // 服务端要求先实名：同样拉起弹层后重试一次。
      // 顺序上放在人机验证之后 —— 服务端也是先查机器人再查身份。
      if (res.status === 403 && code === 'identity_required' && !retried && ensureIdentityReady) {
        const ready = await ensureIdentityReady();
        if (ready) return request(path, { method, body, signal, timeout, retried: true });
        throw new ApiError('需要完成实名验证后才能发布', { status: 403, code: 'identity_cancelled' });
      }
      throw new ApiError(describeError(res.status, payload), {
        status: res.status,
        retryAfter: Number(payload?.retryAfter) || 0,
        code,
      });
    }
    return payload;
  }

  /**
   * 写操作包装：命中「需要人机验证」时先走验证，再自动重试一次。
   * 只重试一次，且只在 challenge_required 时重试 —— 避免验证失败造成请求风暴。
   */
  async function requestWrite(path, options) {
    try {
      return await request(path, options);
    } catch (err) {
      if (err?.code !== 'challenge_required' || !ensureChallengeReady) throw err;

      const ready = await ensureChallengeReady();
      if (!ready) {
        throw new ApiError('需要完成人机验证后才能继续', { status: 403, code: 'challenge_cancelled' });
      }
      return request(path, options);
    }
  }

  return {
    kind: 'http',

    async health(signal) {
      await request('/api/health', { signal, timeout: 2500 });
      return true;
    },

    async listPosts({ cat, sort, q, cursor, signal }) {
      const params = new URLSearchParams();
      if (cat && cat !== '全部') params.set('cat', cat);
      params.set('sort', sort === 'hot' ? 'hot' : 'new');
      if (q) params.set('q', q);
      if (cursor) params.set('cursor', String(cursor));
      params.set('limit', String(PAGE_SIZE));

      const data = await request(`/api/posts?${params.toString()}`, { signal });
      const items = (data.items || []).map((it) => ({
        id: it.id,
        cat: it.cat,
        body: it.body,
        likes: Number(it.likes) || 0,
        liked: false, // 由 App 层用本地点赞记录补齐
        comments: Number(it.comments) || 0,
        createdAt: Number(it.createdAt) || Date.now(),
      }));
      return { items, nextCursor: data.nextCursor ?? null, sort: data.sort === 'hot' ? 'hot' : 'new' };
    },

    /** 返回 {id,status:'pending'} —— 内容进入审核队列，不直接出现在墙上 */
    async createPost({ cat, body }) {
      const data = await requestWrite('/api/posts', { method: 'POST', body: { cat, body } });
      return { id: data.id, status: data.status || 'pending' };
    },

    async toggleLike(id, { liked }) {
      const data = await requestWrite(`/api/posts/${encodeURIComponent(id)}/like`, { method: 'POST' });
      return { liked: Boolean(data.liked), likes: Number(data.likes) || 0 };
    },

    async listComments(id, { signal } = {}) {
      const data = await request(`/api/posts/${encodeURIComponent(id)}/comments`, { signal });
      return (data.items || []).map((c) => ({
        id: c.id,
        who: '匿名',
        text: c.body,
        createdAt: Number(c.createdAt) || Date.now(),
      }));
    },

    /** 命中合规规则时 status 为 pending，即「先审后发」 */
    async createComment(id, body) {
      const data = await requestWrite(`/api/posts/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        body: { body },
      });
      return { id: data.id, status: data.status === 'pending' ? 'pending' : 'approved' };
    },

    async createReport(postId, reason) {
      await requestWrite('/api/reports', { method: 'POST', body: { postId, reason } });
      return { ok: true };
    },
  };
}

/* ─────────────────────────── 本地适配器 ─────────────────────────── */

/** 与后端 moderation.js 同口径的极简预筛，仅供演示提示用（后端才是权威） */
const CONTACT_PATTERNS = [
  /1[3-9]\d{9}/, // 手机号
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // 邮箱
  /(微信|wechat|wx|QQ|qq)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/i,
];

function localFlagged(text) {
  return CONTACT_PATTERNS.some((re) => re.test(text));
}

/**
 * 本地演示模式的 keyset 翻页。
 *
 * 必须与后端游标格式一致（sort=new 用 "createdAt.id"，sort=hot 用 "likes.id"），
 * 因为前端把 nextCursor 原样回传。若这里只认纯 id，切到真实后端后
 * 翻页会静默失效 —— 第二页永远返回同一批数据。同时兼容旧的纯 id 游标，
 * 已存在的 localStorage 数据不会因此报错。
 */
function paginate(items, cursor, sort) {
  let start = 0;
  if (cursor) {
    const [rawFirst, rawSecond] = String(cursor).split('.');
    const first = Number(rawFirst);
    const second = Number(rawSecond);

    if (rawSecond !== undefined && Number.isFinite(first) && Number.isFinite(second)) {
      const idx = items.findIndex((p) => (sort === 'hot'
        ? p.likes === first && String(p.id) === String(rawSecond)
        : p.createdAt === first && String(p.id) === String(rawSecond)));
      start = idx >= 0 ? idx + 1 : items.length; // 定位不到就视为到底，避免重复吐数据
    } else if (Number.isFinite(first)) {
      const idx = items.findIndex((p) => String(p.id) === String(rawFirst));
      start = idx >= 0 ? idx + 1 : items.length;
    }
  }

  const page = items.slice(start, start + PAGE_SIZE);
  const hasMore = start + PAGE_SIZE < items.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? (sort === 'hot' ? `${last.likes}.${last.id}` : `${last.createdAt}.${last.id}`)
    : null;

  return { items: page, nextCursor, sort };
}

function createLocalAdapter() {
  /** @type {{posts: any[], pending: any[], reports: any[]}} */
  let db = readJSON(STORE_KEY, null) || { posts: seedPosts(), pending: [], reports: [] };
  if (!Array.isArray(db.posts) || !db.posts.length) db = { posts: seedPosts(), pending: [], reports: [] };

  const persist = () => writeJSON(STORE_KEY, db);
  const sortPosts = (list, sort) => {
    const out = list.slice();
    if (sort === 'hot') out.sort((a, b) => (b.likes - a.likes) || (b.createdAt - a.createdAt));
    else out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  };
  const matches = (p, cat, q) => {
    if (cat && cat !== '全部' && p.cat !== cat) return false;
    if (q) {
      const needle = q.toLowerCase();
      if (!(`${p.body} ${p.cat}`).toLowerCase().includes(needle)) return false;
    }
    return true;
  };

  // 删除记录在 localStorage 里的演示数据，恢复出厂种子
  function reset() {
    db = { posts: seedPosts(), pending: [], reports: [] };
    persist();
  }

  return {
    kind: 'local',
    reset,

    async health() {
      return true;
    },

    async listPosts({ cat = '全部', sort = 'new', q = '', cursor = null }) {
      const filtered = sortPosts(db.posts.filter((p) => matches(p, cat, q)), sort);
      const items = filtered.map((p) => ({
        id: p.id,
        cat: p.cat,
        body: p.body,
        likes: p.likes,
        liked: Boolean(p.liked),
        comments: (p.comments || []).length,
        createdAt: p.createdAt,
      }));

      return paginate(items, cursor, sort);
    },

    async createPost({ cat, body }) {
      const post = {
        id: `n${Date.now()}`,
        cat,
        body,
        createdAt: Date.now(),
        likes: 0,
        liked: false,
        comments: [],
        flag: localFlagged(body) ? 'contact' : null,
      };
      db.pending.push(post);
      persist();
      return { id: post.id, status: 'pending' };
    },

    async toggleLike(id) {
      const post = db.posts.find((p) => String(p.id) === String(id));
      if (!post) throw new ApiError('这条内容已不存在', { status: 404 });
      post.liked = !post.liked;
      post.likes += post.liked ? 1 : -1;
      persist();
      return { liked: post.liked, likes: post.likes };
    },

    /** 演示模式第一次展开评论时，把种子里预置的评论返回 */
    async listComments(id) {
      const post = db.posts.find((p) => String(p.id) === String(id));
      if (!post) return [];
      return (post.comments || []).map((c) => ({
        id: c.id,
        who: c.who || '匿名',
        text: c.text,
        createdAt: c.createdAt,
      }));
    },

    async createComment(id, body) {
      const post = db.posts.find((p) => String(p.id) === String(id));
      if (!post) throw new ApiError('这条内容已不存在', { status: 404 });
      const flagged = localFlagged(body);
      const comment = { id: `c${Date.now()}`, who: '匿名', text: body, createdAt: Date.now() };
      if (!flagged) {
        post.comments = post.comments || [];
        post.comments.push(comment);
      }
      persist();
      return { id: comment.id, status: flagged ? 'pending' : 'approved' };
    },

    async createReport(postId, reason) {
      const post = db.posts.find((p) => String(p.id) === String(postId));
      db.reports.push({
        id: `r${Date.now()}`,
        postId,
        reason: (reason || '').slice(0, 200),
        excerpt: post ? post.body.slice(0, 40) : '',
        at: Date.now(),
        status: 'open',
      });
      persist();
      return { ok: true };
    },
  };
}

/* ─────────────────────────── 工厂 / 探测 ─────────────────────────── */

function readEnvMode() {
  const fromStorage = readJSON(MODE_KEY, null);
  const env = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DATA_MODE : '';
  const mode = fromStorage || env || 'auto';
  return ['auto', 'api', 'local'].includes(mode) ? mode : 'auto';
}

/** @returns {Promise<{ adapter: any, source: import('./types.js').ActiveSource, mode: DataMode, error: string }>} */
export async function createAdapter() {
  const mode = readEnvMode();
  const local = createLocalAdapter();

  if (mode === 'local') {
    return { adapter: local, source: 'local', mode, error: '' };
  }

  const http = createHttpAdapter();
  try {
    await http.health();
    return { adapter: http, source: 'api', mode, error: '' };
  } catch (err) {
    if (mode === 'api') {
      return { adapter: http, source: 'api', mode, error: err?.message || '后端不可用' };
    }
    return { adapter: local, source: 'fallback', mode, error: err?.message || '后端不可用' };
  }
}

export { createHttpAdapter, createLocalAdapter };
