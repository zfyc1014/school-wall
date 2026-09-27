"use strict";

/**
 * 校园表白墙后端 · 单文件 HTTP 服务
 *
 * 设计目标（最低配置 VPS / 香港）：
 *   - 零框架：只用 Node 内置 http，常驻内存小，冷启动快；
 *   - 零数据库进程：SQLite WAL，省掉 MySQL/Postgres 常驻内存；
 *   - keyset 分页：`WHERE id < ? ORDER BY id DESC LIMIT n`，深翻页也不扫全表；
 *   - 点赞计数批量回写：写路径合并为一次事务，降低 fsync 次数；
 *   - 默认只监听 127.0.0.1，由 Caddy/Nginx 终止 TLS（低配机器不做 TLS 握手）；
 *   - 全站安全响应头 + 进程内限流 + 请求体上限。
 *
 * 合规相关：
 *   - 不落盘原始 IP，只存 HMAC-SHA256 哈希（PDPO 数据最小化）；
 *   - 先审后发 + 通知—移除工单 + 审核操作留痕；
 *   - 内容预筛命中即转人工（见 moderation.js）。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const db = require("./db");
const { classify } = require("./moderation");
const { limit } = require("./rate-limit");
const challenge = require("./challenge");

/* ────────────────────────────── 配置 ────────────────────────────── */

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const WEB_ROOT = path.resolve(
  process.env.WEB_ROOT || path.join(__dirname, "..", "..")
);
const INDEX_FILE = process.env.INDEX_FILE || "school-confession-wall.html";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const FORCE_HTTPS = process.env.FORCE_HTTPS === "1";
const MAX_BODY = Number(process.env.MAX_BODY || 32768);
const PAGE_MAX = Number(process.env.PAGE_MAX || 30);
const LIKE_FLUSH_MS = Number(process.env.LIKE_FLUSH_MS || 1500);
const IS_PROD = process.env.NODE_ENV === "production";

const CATS = ["表白", "树洞", "寻人", "失物", "致谢"];

function secretOrFatal(name, min) {
  const value = process.env[name];
  if (value && value.length >= min) return value;
  if (IS_PROD) {
    // 同步写 + 不 exit：此时数据库连接还没建立，交由调用方统一收尾
    try {
      fs.writeSync(2, `[fatal] ${name} 未设置或过短（至少 ${min} 字符）\n`);
    } catch { /* ignore */ }
    process.exit(1);
  }
  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(`[warn] ${name} 未配置，已生成临时值（仅开发环境，重启即失效）`);
  return generated;
}

const ADMIN_TOKEN = secretOrFatal("ADMIN_TOKEN", 24);
const IP_SECRET = secretOrFatal("IP_HASH_SECRET", 16);

/**
 * 致命配置错误：说明原因后干净退出。
 *
 * 为什么不能直接 process.exit(1)：
 * 此时 better-sqlite3 连接仍然打开，直接退出会在 Node 退出阶段触发原生断言
 * （RemoveEnvironmentCleanupHook / Statement 析构），进程以 SIGABRT(134) 结束，
 * 既丢掉了写给运维的说明，也让退出码失去意义。
 * 正确顺序：同步写 stderr（避免异步丢日志）→ 关库 → 退出。
 */
function fatalConfig(message) {
  try {
    // 同步写 stderr：console.* 对管道是异步写，紧接着 exit 会把说明丢掉
    fs.writeSync(2, `[fatal] ${message}\n`);
  } catch { /* stderr 不可写时忽略 */ }
  try {
    db.shutdown();
    db.close();
  } catch { /* 关库失败也要退出 */ }
  process.exit(1);
}

// 人机验证配置自检：生产环境未配置 Turnstile 且没有显式放行时，直接终止启动。
// 必须真的调用 —— 只 require 不调用的话，这段保护等于不存在。
challenge.logConfig({ fatal: fatalConfig });

/* ────────────────────────────── 工具 ────────────────────────────── */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Turnstile 需要放行它的脚本与 iframe（官方文档要求的两个来源）：
  //   script-src  https://challenges.cloudflare.com
  //   frame-src   https://challenges.cloudflare.com
  // 仍保留 'unsafe-inline'，因为 React 产物是内联注入的样式；进一步加固可换成 nonce。
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ")
};

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
    const real = req.headers["x-real-ip"];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || "0.0.0.0";
}

function hashIp(ip) {
  return crypto.createHmac("sha256", IP_SECRET).update(String(ip)).digest("hex").slice(0, 24);
}

function baseHeaders(req) {
  const headers = Object.assign({}, SECURITY_HEADERS);
  if (FORCE_HTTPS || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https")) {
    headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}

function finish(req, res, status, body, headers) {
  const merged = Object.assign(baseHeaders(req), headers, { "Content-Length": body.length });
  res.writeHead(status, merged);
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendBuffer(req, res, status, body, headers) {
  const accept = String(req.headers["accept-encoding"] || "");
  if (body.length >= 1024 && /\bgzip\b/.test(accept)) {
    zlib.gzip(body, (err, gz) => {
      if (err) return finish(req, res, status, body, headers);
      finish(req, res, status, gz, Object.assign({}, headers, {
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding"
      }));
    });
  } else {
    finish(req, res, status, body, headers);
  }
}

function sendJson(req, res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj));
  sendBuffer(req, res, status, body, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, extraHeaders || {}));
}

/**
 * 带 ETag 的 JSON 响应（用于信息流这类可缓存读接口）。
 *
 * 低配 VPS 上省的是「一次完整查询 + 一次 JSON 序列化 + 一次 gzip」，
 * 重复请求只需比对 ETag 后回 304（几十字节）。
 * 缓存只存活在进程内且条目很少（见 feedCache），不会随流量膨胀。
 */
function sendJsonCached(req, res, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj));
  const etag = `W/"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, Object.assign(baseHeaders(req), {
      ETag: etag,
      "Cache-Control": "private, no-cache",
      "Content-Length": 0
    }));
    return res.end();
  }

  sendBuffer(req, res, 200, body, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-cache", // 允许条件请求，但不允许共享缓存
    ETag: etag
  }, extraHeaders || {}));
}

function httpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw httpError(400, "invalid json");
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

function cleanCat(value) {
  const cat = String(value || "").trim();
  return CATS.includes(cat) ? cat : null;
}

function isAdmin(req) {
  const header = String(req.headers["authorization"] || "");
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : String(req.headers["x-admin-token"] || "");
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function audit(action, target, note, ip) {
  db.prepare(
    "INSERT INTO audit_log (action, target, note, ip_hash, created_at) VALUES (?,?,?,?,?)"
  ).run(action, target == null ? null : String(target), note || null, hashIp(ip), Date.now());
}

/* ─────────────────────── 人机验证 / 限流 小工具 ─────────────────────── */

/**
 * 写操作统一入口：先过人机验证，再过限流。
 * 顺序很重要 —— 先挡机器人，再消耗限流计数，避免脚本靠打满限流把正常访客挤掉。
 *
 * @returns {Promise<boolean>} true 表示可以继续处理；false 表示已响应，直接返回
 */
async function requireChallenge(ctx) {
  const gate = await challenge.guardWrite(ctx.req, ctx);
  if (gate.ok) return true;
  sendJson(ctx.req, ctx.res, gate.status, {
    error: gate.error,
    message: gate.message
  });
  return false;
}

/* ─────────────────────── 点赞计数批量回写 ─────────────────────── */

const dirtyLikes = new Set();

function queueLikeCount(postId) {
  dirtyLikes.add(postId);
}

const flushLikes = db.transaction((ids) => {
  const update = db.prepare(
    "UPDATE posts SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = ?) WHERE id = ?"
  );
  for (const id of ids) update.run(id, id);
});

function flushDirtyLikes() {
  if (!dirtyLikes.size) return;
  const ids = Array.from(dirtyLikes);
  dirtyLikes.clear();
  try {
    flushLikes(ids);
  } catch (err) {
    console.error("[like-flush]", err.message);
  }
}

const likeSweeper = setInterval(flushDirtyLikes, LIKE_FLUSH_MS);
likeSweeper.unref();

/* ─────────────────────── 信息流短时缓存 ─────────────────────── */

/**
 * 首屏是绝对热点（每个访客一次，可能还有多页）。
 * 这里按「查询参数」缓存序列化好的结果若干毫秒，把同一瞬间涌入的请求
 * 合并成一次数据库查询 —— 对 1 vCPU 的机器意义最大。
 *
 * 约束：
 *   - 条目上限很小（FEED_CACHE_MAX），到期即删，内存占用恒定；
 *   - 任何写操作（发帖/审核）都会 bumpFeedCache()，保证不会读到陈旧列表。
 */
const FEED_CACHE_MS = Number(process.env.FEED_CACHE_MS || 3000);
const FEED_CACHE_MAX = 64;
const feedCache = new Map(); // key -> { at, payload }
let feedGeneration = 0;

function feedKey(ctx) {
  return [
    ctx.query.get("cat") || "",
    ctx.query.get("sort") || "new",
    ctx.query.get("q") || "",
    ctx.query.get("cursor") || "",
    ctx.query.get("limit") || ""
  ].join("\u0000");
}

function feedCached(key) {
  if (!FEED_CACHE_MS) return null;
  const hit = feedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > FEED_CACHE_MS || hit.gen !== feedGeneration) {
    feedCache.delete(key);
    return null;
  }
  return hit.payload;
}

function feedStore(key, payload) {
  if (!FEED_CACHE_MS) return;
  if (feedCache.size >= FEED_CACHE_MAX) {
    // 简单的 FIFO 淘汰：够用且没有额外内存结构
    const oldest = feedCache.keys().next().value;
    if (oldest !== undefined) feedCache.delete(oldest);
  }
  feedCache.set(key, { at: Date.now(), payload, gen: feedGeneration });
}

/** 任何影响列表内容的写入都会调用它，使缓存立即失效 */
function bumpFeedCache() {
  feedGeneration += 1;
}

/* ────────────────────────────── 路由 ────────────────────────────── */

const ROUTES = [];

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    "^" + pattern.replace(/:[A-Za-z]+/g, (m) => {
      keys.push(m.slice(1));
      return "([^/]+)";
    }) + "$"
  );
  ROUTES.push({ method, regex, keys, handler });
}

const POST_COLUMNS =
  "id, cat, body, like_count, comment_count, created_at";

function feedItem(row) {
  return {
    id: row.id,
    cat: row.cat,
    body: row.body,
    likes: row.like_count,
    comments: row.comment_count,
    createdAt: row.created_at
  };
}

// GET /api/health
route("GET", "/api/health", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, { ok: true, now: Date.now() });
});

/* ───────────────────────── 人机验证（Turnstile） ─────────────────────────
 * 入口闸门：前端拉配置 → 渲染托管 widget → 把一次性 token 交给
 * POST /api/challenge/session → 服务端校验后签发短期会话 cookie。
 * 之后所有写操作只需带这个 cookie，不再往返 Cloudflare。
 * ---------------------------------------------------------------------- */

// GET /api/challenge/config —— 公开配置（sitekey 本身不是机密）+ 当前会话状态
route("GET", "/api/challenge/config", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, Object.assign(challenge.publicConfig(), {
    verified: challenge.hasSession(ctx.req, ctx.ipHash),
    sessionTtl: challenge.TTL_SECONDS
  }));
});

// POST /api/challenge/session  { token } —— 用一次性 token 换会话 cookie
route("POST", "/api/challenge/session", async (ctx) => {
  // 校验接口本身也要限流，避免被当作 Turnstile 校验放大器
  const bucket = limit(`challenge:${ctx.ipHash}`, 20, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const token = String(payload.token || ctx.req.headers["cf-turnstile-response"] || "");

  const result = await challenge.verifyToken(ctx.req, {
    token,
    ip: ctx.ip,
    ipHash: ctx.ipHash
  });

  if (!result.success) {
    return sendJson(ctx.req, ctx.res, result.code === "verify_unavailable" ? 503 : 403, {
      error: result.code,
      message: result.message,
      codes: result.codes || undefined
    });
  }

  const headers = { "Cache-Control": "no-store" };
  if (result.cookie) headers["Set-Cookie"] = result.cookie;
  sendJson(ctx.req, ctx.res, 200, {
    verified: true,
    expiresIn: challenge.TTL_SECONDS,
    hostname: result.hostname || undefined
  }, headers);
});

// POST /api/challenge/logout —— 主动结束会话（前端「重新验证」用）
route("POST", "/api/challenge/logout", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, { verified: false }, {
    "Set-Cookie": challenge.clearCookie(),
    "Cache-Control": "no-store"
  });
});

// GET /api/posts?cat=&sort=new|hot&q=&cursor=&limit=
route("GET", "/api/posts", (ctx) => {
  const cat = cleanCat(ctx.query.get("cat"));
  const sort = ctx.query.get("sort") === "hot" ? "hot" : "new";
  const q = String(ctx.query.get("q") || "").trim().slice(0, 60);
  const take = clamp(toInt(ctx.query.get("limit"), 20), 1, PAGE_MAX);
  const cursor = ctx.query.get("cursor") || "";

  // 命中短时缓存：重复/并发请求不再各查一次库
  const key = feedKey(ctx);
  const cached = feedCached(key);
  if (cached) {
    return sendJsonCached(ctx.req, ctx.res, cached, { "X-Cache": "hit" });
  }

  const where = ["status = 'approved'"];
  const args = [];

  if (cat) {
    where.push("cat = ?");
    args.push(cat);
  }
  if (q) {
    where.push("body LIKE ? ESCAPE '\\'");
    args.push("%" + escapeLike(q) + "%");
  }

  let sql;
  if (sort === "new") {
    // 游标格式 "created_at.id"；同时兼容旧版纯 id 游标（升级时不会 500）
    const [rawTime, rawId] = String(cursor).split(".");
    let createdAt = toInt(rawTime, 0);
    const lastId = toInt(rawId, 0);
    if (lastId > 0 && !rawId) createdAt = 0;

    if (lastId > 0) {
      if (createdAt > 0) {
        // 行值元组比较：SQLite 会把它当成一次索引区间扫描。
        // 若改写成 (created_at < ? OR (created_at = ? AND id < ?))，
        // 优化器会走 MULTI-INDEX OR 并额外做一次临时 B 树排序 —— 实测结果。
        where.push("(created_at, id) < (?, ?)");
        args.push(createdAt, lastId);
      } else {
        // 旧游标：只按 id 翻页（id 单调递增，等价于按时间倒序）
        where.push("id < ?");
        args.push(lastId);
      }
    }
    sql = `SELECT ${POST_COLUMNS} FROM posts WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, id DESC LIMIT ?`;
    args.push(take + 1);
  } else {
    const parts = String(cursor).split(".");
    const likes = toInt(parts[0], -1);
    const id = toInt(parts[1], 0);
    if (likes >= 0 && id > 0) {
      where.push("(like_count, id) < (?, ?)");
      args.push(likes, id);
    }
    sql = `SELECT ${POST_COLUMNS} FROM posts WHERE ${where.join(" AND ")}
           ORDER BY like_count DESC, id DESC LIMIT ?`;
    args.push(take + 1);
  }

  const rows = db.prepare(sql).all(...args);
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1] || null;
  const nextCursor = hasMore && last
    ? (sort === "hot" ? `${last.like_count}.${last.id}` : `${last.created_at}.${last.id}`)
    : null;

  const payload = {
    items: page.map(feedItem),
    nextCursor,
    sort
  };

  feedStore(key, payload);
  sendJsonCached(ctx.req, ctx.res, payload, { "X-Cache": "miss" });
});

// POST /api/posts  { cat, body }
route("POST", "/api/posts", async (ctx) => {
  if (!(await requireChallenge(ctx))) return;

  const bucket = limit(`post:${ctx.ipHash}`, 3, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const cat = cleanCat(payload.cat);
  const body = String(payload.body || "").trim();

  if (!cat) throw httpError(400, "invalid category");
  if (body.length < 6 || body.length > 500) throw httpError(400, "invalid length");

  const mod = classify(body);
  const info = db
    .prepare(
      `INSERT INTO posts (cat, body, status, flag, ip_hash, ua_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(cat, body, "pending", mod.flagged ? mod.flags.join(",") : null, ctx.ipHash, ctx.uaHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { id: info.lastInsertRowid, status: "pending" });
});

// POST /api/posts/:id/like —— 幂等切换（同一 IP 再点即取消）
route("POST", "/api/posts/:id/like", async (ctx) => {
  if (!(await requireChallenge(ctx))) return;

  const bucket = limit(`like:${ctx.ipHash}`, 120, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const postId = toInt(ctx.params.id, 0);
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  const existing = db
    .prepare("SELECT 1 AS on FROM likes WHERE post_id = ? AND ip_hash = ?")
    .get(postId, ctx.ipHash);

  const toggle = db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM likes WHERE post_id = ? AND ip_hash = ?").run(postId, ctx.ipHash);
    } else {
      db.prepare("INSERT INTO likes (post_id, ip_hash, created_at) VALUES (?,?,?)")
        .run(postId, ctx.ipHash, Date.now());
    }
  });
  toggle();

  queueLikeCount(postId); // 计数异步批量回写
  const likes = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").get(postId).n;

  sendJson(ctx.req, ctx.res, 200, { liked: !existing, likes });
});

// GET /api/posts/:id/comments
route("GET", "/api/posts/:id/comments", (ctx) => {
  const postId = toInt(ctx.params.id, 0);
  const rows = db
    .prepare(
      `SELECT id, body, created_at FROM comments
       WHERE post_id = ? AND status = 'approved' ORDER BY id ASC LIMIT 200`
    )
    .all(postId);
  sendJson(ctx.req, ctx.res, 200, {
    items: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at }))
  });
});

// POST /api/posts/:id/comments  { body }
route("POST", "/api/posts/:id/comments", async (ctx) => {
  if (!(await requireChallenge(ctx))) return;

  const bucket = limit(`comment:${ctx.ipHash}`, 20, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const postId = toInt(ctx.params.id, 0);
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  const payload = await readJson(ctx.req);
  const body = String(payload.body || "").trim();
  if (body.length < 1 || body.length > 120) throw httpError(400, "invalid length");

  const mod = classify(body);
  const status = mod.flagged ? "pending" : "approved";

  const info = db
    .prepare(
      `INSERT INTO comments (post_id, body, status, flag, ip_hash, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(postId, body, status, mod.flagged ? mod.flags.join(",") : null, ctx.ipHash, Date.now());

  if (status === "approved") {
    db.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?").run(postId);
  }

  sendJson(ctx.req, ctx.res, 201, { id: info.lastInsertRowid, status });
});

// POST /api/reports  { postId, reason }
route("POST", "/api/reports", async (ctx) => {
  if (!(await requireChallenge(ctx))) return;

  const bucket = limit(`report:${ctx.ipHash}`, 10, 60 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const postId = toInt(payload.postId, 0);
  const reason = String(payload.reason || "").trim().slice(0, 200);
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  // 同一 IP 对同一帖只记一次工单：避免重复举报把队列刷爆（也省一次写）
  const dup = db
    .prepare("SELECT id FROM reports WHERE post_id = ? AND ip_hash = ? AND status = 'open' LIMIT 1")
    .get(postId, ctx.ipHash);
  if (dup) return sendJson(ctx.req, ctx.res, 200, { ok: true, duplicated: true });

  db.prepare("INSERT INTO reports (post_id, reason, ip_hash, created_at) VALUES (?,?,?,?)")
    .run(postId, reason || null, ctx.ipHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { ok: true });
});

/* ───────────────────────── 管理接口（需鉴权） ───────────────────────── */

function requireAdmin(ctx) {
  const authBucket = limit(`admin:${ctx.ipHash}`, 10, 15 * 60 * 1000);
  if (!authBucket.ok) {
    sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: authBucket.retryAfter });
    return false;
  }
  if (!isAdmin(ctx.req)) {
    sendJson(ctx.req, ctx.res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

// GET /api/admin/stats
route("GET", "/api/admin/stats", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const disk = db.stats();
  sendJson(ctx.req, ctx.res, 200, {
    pendingPosts: one("SELECT COUNT(*) AS n FROM posts WHERE status='pending'"),
    pendingComments: one("SELECT COUNT(*) AS n FROM comments WHERE status='pending'"),
    openReports: one("SELECT COUNT(*) AS n FROM reports WHERE status='open'"),
    approvedPosts: one("SELECT COUNT(*) AS n FROM posts WHERE status='approved'"),
    // 数据库体积与可回收空间：低配 VPS 上最该盯的两个数
    db: {
      fileBytes: disk.fileBytes,
      reclaimableBytes: disk.reclaimableBytes,
      walBytes: disk.walBytes,
      cacheMb: disk.cacheMb,
      counts: disk.counts
    }
  });
});

// GET /api/admin/queue?type=posts|comments&limit=
route("GET", "/api/admin/queue", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const type = ctx.query.get("type") === "comments" ? "comments" : "posts";
  const take = clamp(toInt(ctx.query.get("limit"), 50), 1, 100);

  if (type === "comments") {
    const rows = db
      .prepare(
        `SELECT id, post_id, body, flag, created_at FROM comments
         WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
      )
      .all(take);
    return sendJson(ctx.req, ctx.res, 200, { type, items: rows });
  }

  const rows = db
    .prepare(
      `SELECT id, cat, body, flag, created_at FROM posts
       WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
    )
    .all(take);
  sendJson(ctx.req, ctx.res, 200, { type, items: rows });
});

const REVIEW = {
  approve: "approved",
  reject: "rejected",
  remove: "removed"
};

for (const action of Object.keys(REVIEW)) {
  route("POST", `/api/admin/posts/:id/${action}`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const postId = toInt(ctx.params.id, 0);
    const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(postId);
    if (!post) throw httpError(404, "post not found");

    db.prepare("UPDATE posts SET status = ?, reviewed_at = ? WHERE id = ?")
      .run(REVIEW[action], Date.now(), postId);
    audit(`post.${action}`, postId, null, ctx.ip);
    bumpFeedCache(); // 通过/下架都会改变公开列表，立即失效缓存
    sendJson(ctx.req, ctx.res, 200, { id: postId, status: REVIEW[action] });
  });
}

for (const action of ["approve", "reject"]) {
  route("POST", `/api/admin/comments/:id/${action}`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const commentId = toInt(ctx.params.id, 0);
    const comment = db.prepare("SELECT id, post_id, status FROM comments WHERE id = ?").get(commentId);
    if (!comment) throw httpError(404, "comment not found");

    const next = action === "approve" ? "approved" : "rejected";
    // 计数必须跟着状态变化走：通过 +1，把已通过的评论驳回则 -1，
    // 否则 comment_count 会随着审核动作单向上漂，墙上显示的评论数就不可信了。
    const delta = (next === "approved" && comment.status !== "approved") ? 1
      : (next !== "approved" && comment.status === "approved") ? -1
      : 0;

    const apply = db.transaction(() => {
      db.prepare("UPDATE comments SET status = ? WHERE id = ?").run(next, commentId);
      if (delta) {
        db.prepare(
          "UPDATE posts SET comment_count = MAX(0, comment_count + ?) WHERE id = ?"
        ).run(delta, comment.post_id);
      }
    });
    apply();

    audit(`comment.${action}`, commentId, delta ? `post:${comment.post_id} delta:${delta}` : null, ctx.ip);
    sendJson(ctx.req, ctx.res, 200, { id: commentId, status: next, commentCountDelta: delta });
  });
}

// GET /api/admin/reports?status=open|actioned|dismissed|all
route("GET", "/api/admin/reports", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const status = ctx.query.get("status") || "open";
  const rows = status === "all"
    ? db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 100").all()
    : db.prepare("SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 100").all(status);
  sendJson(ctx.req, ctx.res, 200, { items: rows });
});

// POST /api/admin/reports/:id/resolve  { action: 'takedown' | 'dismiss' }
route("POST", "/api/admin/reports/:id/resolve", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const reportId = toInt(ctx.params.id, 0);
  const payload = await readJson(ctx.req);
  const action = payload.action === "takedown" ? "takedown" : "dismiss";

  const report = db.prepare("SELECT id, post_id FROM reports WHERE id = ?").get(reportId);
  if (!report) throw httpError(404, "report not found");

  const resolve = db.transaction(() => {
    if (action === "takedown") {
      db.prepare("UPDATE posts SET status = 'removed', reviewed_at = ? WHERE id = ?")
        .run(Date.now(), report.post_id);
      db.prepare("UPDATE reports SET status = 'actioned', resolved_at = ? WHERE id = ?")
        .run(Date.now(), reportId);
    } else {
      db.prepare("UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE id = ?")
        .run(Date.now(), reportId);
    }
  });
  resolve();

  if (action === "takedown") bumpFeedCache();
  audit(`report.${action}`, reportId, `post:${report.post_id}`, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { id: reportId, action });
});

/* ───────────────────────────── 静态资源 ───────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function serveStatic(ctx) {
  const { req, res } = ctx;
  let rel = decodeURIComponent(ctx.pathname);
  if (rel === "/") rel = "/" + INDEX_FILE;

  const filePath = path.join(WEB_ROOT, rel);
  if (!filePath.startsWith(WEB_ROOT + path.sep)) throw httpError(403, "forbidden");

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw httpError(404, "not found");
  }
  if (!stat.isFile()) throw httpError(404, "not found");

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders(req));
    return res.end();
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const immutable = /\.(css|js|png|jpe?g|webp|avif|svg|woff2?|ico)$/i.test(filePath);
  const headers = {
    "Content-Type": type,
    "Cache-Control": immutable ? "public, max-age=86400" : "no-cache",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString()
  };

  const isText = /^(text\/|application\/(json|javascript)|image\/svg)/.test(type);
  if (isText && stat.size < 2 * 1024 * 1024) {
    return sendBuffer(req, res, 200, fs.readFileSync(filePath), headers);
  }

  res.writeHead(200, Object.assign(baseHeaders(req), headers, { "Content-Length": stat.size }));
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/* ───────────────────────────── 分发 ───────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ctx = {
    req,
    res,
    pathname: url.pathname,
    query: url.searchParams,
    ip: clientIp(req),
    ipHash: hashIp(clientIp(req)),
    uaHash: crypto.createHash("sha256").update(String(req.headers["user-agent"] || "")).digest("hex").slice(0, 16),
    params: {}
  };

  try {
    if (ctx.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        return finish(req, res, 204, Buffer.alloc(0), {
          Allow: "GET, HEAD, POST, OPTIONS",
          "Cache-Control": "no-store"
        });
      }
      for (const r of ROUTES) {
        if (r.method !== req.method) continue;
        const match = r.regex.exec(ctx.pathname);
        if (!match) continue;
        r.keys.forEach((key, i) => {
          ctx.params[key] = decodeURIComponent(match[i + 1]);
        });
        return await r.handler(ctx);
      }
      return sendJson(req, res, 404, { error: "not_found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(req, res, 405, { error: "method_not_allowed" });
    }
    serveStatic(ctx);
  } catch (err) {
    const code = typeof err.code === "number" ? err.code : 500;
    if (code >= 500) console.error("[error]", (err && err.stack) || err);
    if (!res.headersSent) {
      const label = code === 413 ? "payload_too_large"
        : code === 400 ? "bad_request"
        : code === 403 ? "forbidden"
        : code === 404 ? "not_found"
        : "server_error";
      sendJson(req, res, code, { error: label });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[up] 表白墙服务 http://${HOST}:${PORT}`);
  console.log(`[up] 静态根目录 ${WEB_ROOT}`);
  console.log(`[up] 数据库 ${db.DB_PATH}（页缓存 ${db.CACHE_MB}MB）`);
  console.log(`[up] 人机验证 ${challenge.ENABLED ? "开启" : "关闭"}`
    + `（sitekey ${challenge.CONFIGURED ? "已配置" : "未配置"}）`);
});

/* ─────────────────────────── 优雅退出 ─────────────────────────── */

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[down] 收到 ${signal}，正在收尾…`);
  clearInterval(likeSweeper);
  flushDirtyLikes();
  server.close(() => {
    db.shutdown(); // 标记干净退出 + optimize + WAL 截断，避免下次启动触发全量校准
    try {
      db.close();
    } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => console.error("[uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[unhandled]", err));

// 退出原因留痕：进程在没有任何信号的情况下退出时，这里能告诉我们是谁触发的
// （setImmediate 的 stack 会指向调用 process.exit 的位置）。
if (process.env.DEBUG_EXIT === "1") {
  process.on("exit", (code) => {
    const stack = new Error("exit").stack;
    try {
      fs.writeSync(2, `[exit-trace] code=${code}\n${stack}\n`);
    } catch { /* ignore */ }
  });
}
