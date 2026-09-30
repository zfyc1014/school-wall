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
 * 内测版本（0.9.x）说明：
 *   - 写操作闸门是**自托管**的「内测邀请码 + 一次性本地挑战」（见 gate.js），
 *     不依赖任何第三方、不出网；原先的 Cloudflare Turnstile 已整体移除；
 *   - 内测阶段不收集手机号，实名与短信相关代码已删除（需要时从 git 历史取回）；
 *   - 新增 POST /api/feedback（内测反馈）与后台反馈队列；
 *   - 后台审核接口沿用 v2.1.0 的控制台版本（队列分页/批量/详情/审核日志）。
 *
 * 合规相关：
 *   - 不落盘原始 IP，只存 HMAC-SHA256 哈希（PDPO 数据最小化）；
 *   - 先审后发 + 通知—移除工单 + 审核操作留痕；
 *   - 内容预筛命中即转人工（见 moderation.js，含 NFKC 归一化与词表热重载）。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// 先加载 server/.env（面板部署没有 shell，配置只能写文件）——必须在 db/gate 之前，
// 因为它们是在 require 时读取 process.env 的。
const { LOADED: ENV_LOADED, ENV_FILE } = require("./env");
const db = require("./db");
const { classify } = require("./moderation");
const { limit } = require("./rate-limit");
const gate = require("./gate");
const beta = require("./beta");

/* ────────────────────────────── 配置 ────────────────────────────── */

/**
 * 端口 / 监听地址。
 *
 * 面板（Pterodactyl / Wispbyte 等）分配的端口是动态的，而且容器**必须**监听在
 * 那个端口上，否则面板反代回来就是 502。面板会把分配到的端口注入为 SERVER_PORT、
 * 监听地址注入为 SERVER_IP，因此优先级是：显式 PORT/HOST > 面板变量 > 默认值。
 *
 * 为什么要逐个校验而不是直接 `Number(...)`（踩过的坑）：
 *   `.env` 里写 `PORT=<面板端口>`、`PORT=$SERVER_PORT` 这类「看起来像变量」的值时，
 *   `Number()` 得到 NaN，Node 会抛
 *     RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536
 *   —— 一个配置笔误就变成崩溃重启循环，而且日志里完全看不出是哪一行配置的问题。
 *   现在的行为：**非法值一律忽略并告警**，继续尝试下一个来源；全都不行才退回 8080。
 */
function parsePort(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

const PORT_SOURCES = [["PORT", process.env.PORT], ["SERVER_PORT", process.env.SERVER_PORT]];
let PORT = null;
let PORT_SOURCE = "";
for (const [name, raw] of PORT_SOURCES) {
  const parsed = parsePort(raw);
  if (parsed) {
    PORT = parsed;
    PORT_SOURCE = name;
    break;
  }
  if (String(raw == null ? "" : raw).trim()) {
    console.warn(`[warn] ${name}=${JSON.stringify(raw)} 不是合法端口（1–65535），已忽略`);
  }
}
if (!PORT) {
  PORT = 8080;
  PORT_SOURCE = "默认";
  console.warn("[warn] 没有可用的端口配置，先监听 8080。"
    + "面板部署请到 Network/Allocation 页查看分配到的端口，并在 server/.env 写 PORT=那个数字（只写数字，不要写变量引用）");
}

/** 面板环境：由面板注入的两个变量判断，此时默认监听 0.0.0.0 才对容器外可达 */
const IS_PANEL = Boolean(process.env.SERVER_PORT || process.env.SERVER_IP);
const HOST = process.env.HOST || process.env.SERVER_IP || (IS_PANEL ? "0.0.0.0" : "127.0.0.1");

/** 默认静态根：优先用 Vite 构建产物 web/dist，退回仓库根（源码目录） */
const DEFAULT_WEB_ROOT = fs.existsSync(path.join(__dirname, "..", "..", "web", "dist", "index.html"))
  ? path.join(__dirname, "..", "..", "web", "dist")
  : path.join(__dirname, "..", "..");
const WEB_ROOT = path.resolve(process.env.WEB_ROOT || DEFAULT_WEB_ROOT);
/** 服务端自身目录：审核后台等自带资源从这里取，不受 WEB_ROOT 影响 */
const SERVER_ROOT = path.resolve(__dirname, "..");

const INDEX_FILE = process.env.INDEX_FILE || "index.html";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const FORCE_HTTPS = process.env.FORCE_HTTPS === "1";
const MAX_BODY = Number(process.env.MAX_BODY || 32768);
const PAGE_MAX = Number(process.env.PAGE_MAX || 30);
const LIKE_FLUSH_MS = Number(process.env.LIKE_FLUSH_MS || 1500);
const ADMIN_RATE_LIMIT = Number(process.env.ADMIN_RATE_LIMIT || 10);
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

// 内测门禁配置自检：生产环境未配置邀请码且没有显式放行时，直接终止启动。
// 必须真的调用 —— 只 require 不调用的话，这段保护等于不存在。
gate.logConfig({ fatal: fatalConfig });

/* ────────────────────────────── 工具 ────────────────────────────── */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  // 内测版不该被搜索引擎收录：内容与规则都还会变，收录后反而留下历史快照。
  // 与 index.html 的 <meta name="robots"> 双保险（meta 只管前台页，响应头覆盖 /admin）。
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  // 内测版没有任何第三方脚本：CSP 收紧到 'self'，不再需要为外部来源开口子。
  // 仍保留 'unsafe-inline'，因为 React 产物是内联注入的样式；进一步加固可换成 nonce。
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "frame-src 'none'",
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

/* ───────────────────────── 响应压缩（优化热点） ─────────────────────────
 *
 * 内测版把「压缩」从 gzip 升级为 **br 优先、gzip 兜底**，并加了一层
 * 压缩结果缓存。压缩档位不是拍脑袋定的，实测数据（本机 Node 24，
 * 对构建产物逐个量过）：
 *
 *   app js 55KB：gzip-6 19776 | br-q4 20052（更差！）| br-q5 17691 | br-q9 17211 | br-q11 16303
 *   vendor 141KB：gzip-6 45223 | br-q4 45988（更差）  | br-q5 43372 | br-q9 42646 | br-q11 39579
 *   css 25KB：   gzip-6  5157 | br-q4  5501（更差）  | br-q5  4908 | br-q9  4806 | br-q11  4540
 *
 * 两个结论：
 *   1. **br 的默认档 4 是负优化**（比 gzip-6 还大 1%–7%），必须显式抬档；
 *   2. 档位越高越省，但 q11 对 141KB 的包要压 156ms —— 单核机器上不能让
 *      每个请求都付这个钱，所以**只对会被缓存的静态产物用高档**：
 *      静态产物压缩一次就长期复用，q9/q11 的一次性成本完全值得。
 *
 * 因此策略是：
 *   - 带 cacheKey 的静态产物：< 64KB 用 q11，更大的用 q9（一次压缩，之后查表）；
 *   - 动态响应（JSON）：用 q5 —— 耗时与 gzip-6 同量级，体积还能再小 4%–10%；
 *   - 客户端不接受 br 时退回 gzip-6；
 *   - 缓存在内存里有 8MB 字节预算上限，只放静态产物，不会随流量膨胀。
 * -------------------------------------------------------------------- */

const COMPRESS_MIN = 1024;
const COMPRESS_CACHE_MAX = 64;
const COMPRESS_CACHE_BYTES_MAX = 8 * 1024 * 1024; // 最多缓存 8MB 压缩结果
/** 静态产物里「小文件」的分界：超过它就用 9 档，避免单核被压上百毫秒 */
const BROTLI_SMALL_MAX = 64 * 1024;
const compressCache = new Map(); // key -> { enc, buf }
let compressCacheBytes = 0;

/** br 优先（体积更小），其次 gzip；都不支持就原样发送 */
function pickEncoding(acceptEncoding) {
  const accept = String(acceptEncoding || "");
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return "";
}

function compress(body, enc, { cached = false } = {}) {
  return new Promise((resolve) => {
    if (enc === "br") {
      // 静态产物：一次压到最好；动态响应：与 gzip 同量级耗时的 5 档
      const quality = cached ? (body.length < BROTLI_SMALL_MAX ? 11 : 9) : 5;
      zlib.brotliCompress(body, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length
        }
      }, (err, out) => resolve(err ? null : out));
      return;
    }
    zlib.gzip(body, { level: 6 }, (err, out) => resolve(err ? null : out));
  });
}

function storeCompressed(key, enc, buf) {
  if (buf.length > COMPRESS_CACHE_BYTES_MAX) return;
  while (compressCacheBytes + buf.length > COMPRESS_CACHE_BYTES_MAX || compressCache.size >= COMPRESS_CACHE_MAX) {
    const oldest = compressCache.keys().next().value;
    if (oldest === undefined) break;
    compressCacheBytes -= compressCache.get(oldest).buf.length;
    compressCache.delete(oldest);
  }
  compressCache.set(key, { enc, buf });
  compressCacheBytes += buf.length;
}

/**
 * 统一的响应出口。
 * @param {string} [cacheKey] 传入后启用压缩缓存（仅静态产物这样用）
 */
function sendBuffer(req, res, status, body, headers, cacheKey) {
  const enc = pickEncoding(req.headers["accept-encoding"]);
  if (!enc || body.length < COMPRESS_MIN) return finish(req, res, status, body, headers);

  if (cacheKey) {
    const hit = compressCache.get(cacheKey);
    if (hit && hit.enc === enc) {
      return finish(req, res, status, hit.buf, Object.assign({}, headers, {
        "Content-Encoding": enc,
        Vary: "Accept-Encoding"
      }));
    }
  }

  return compress(body, enc, { cached: Boolean(cacheKey) }).then((out) => {
    if (!out) return finish(req, res, status, body, headers);
    if (cacheKey) storeCompressed(cacheKey, enc, out);
    return finish(req, res, status, out, Object.assign({}, headers, {
      "Content-Encoding": enc,
      Vary: "Accept-Encoding"
    }));
  });
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
  // Number(null) === 0、Number("") === 0 —— 缺省参数会被静默吞成 0，
  // 再被 clamp 成 1，于是「不传 limit」变成「只要 1 条」。这条 bug 已经
  // 出现过一次（首屏只返回 1 条），因此必须显式挡住 null / 空串。
  if (value == null || value === "") return fallback;
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

/* ─────────────────────── 门禁 / 限流 小工具 ─────────────────────── */

/**
 * 写操作统一入口：先过内测门禁，再过限流。
 *
 * 顺序很重要 —— 先挡未通过门禁的请求，再消耗限流计数，
 * 避免脚本靠打满限流把正常访客挤掉。
 *
 * 与旧实现（Turnstile）的区别：这里**完全同步**，没有出网请求，
 * 因此写路径不再有「验证服务超时」这个失败模式，也不需要 fail-open 策略。
 *
 * @returns {boolean} true 表示可以继续处理；false 表示已响应，直接返回
 */
function requireGate(ctx) {
  const result = gate.guardWrite(ctx.req, ctx);
  if (result.ok) return true;
  sendJson(ctx.req, ctx.res, result.status, {
    error: result.error,
    message: result.message
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
  sendJson(ctx.req, ctx.res, 200, {
    ok: true,
    now: Date.now(),
    // 版本随健康检查下发：前端探针、监控与「内测版」标识共用同一个值
    version: beta.VERSION,
    tag: beta.NAME
  });
});

/* ───────────────────── 内测门禁（邀请码 + 本地挑战） ─────────────────────
 * 入口闸门：前端拉配置 → 拿一次性挑战题目 → 用户填邀请码 + 答案 →
 * POST /api/gate/verify → 服务端校验后签发短期会话 cookie。
 * 之后所有写操作只需带这个 cookie，不再重复答题。
 * 全流程在本进程内完成，没有任何出网请求。
 * ---------------------------------------------------------------------- */

// GET /api/gate/config —— 公开配置 + 当前会话状态 + 内测版元信息
// 前端一次请求就能决定：要不要弹门禁、首屏公告写什么、反馈入口开不开。
route("GET", "/api/gate/config", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, Object.assign(gate.publicConfig(), {
    verified: gate.hasSession(ctx.req, ctx.ipHash),
    beta: beta.publicConfig()
  }));
});

// POST /api/gate/challenge —— 取一份一次性挑战题目（答案只存在服务端）
route("POST", "/api/gate/challenge", (ctx) => {
  // 题目本身很便宜，但仍要限流：避免被用来做内存增长型压测
  const bucket = limit(`gate-challenge:${ctx.ipHash}`, 30, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }
  if (!gate.ENABLED) {
    // 门禁关闭时不发题，前端据此直接放行（少一次无意义往返）
    return sendJson(ctx.req, ctx.res, 200, { enabled: false });
  }
  sendJson(ctx.req, ctx.res, 200, Object.assign({ enabled: true }, gate.issueChallenge(ctx.ipHash)));
});

// POST /api/gate/verify  { code, challengeId, answers: string[] }
route("POST", "/api/gate/verify", async (ctx) => {
  // 校验接口是枚举邀请码的目标：单独限流，且比出题更严
  const bucket = limit(`gate-verify:${ctx.ipHash}`, 20, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const result = gate.verify({
    inviteCode: payload.code,
    challengeId: payload.challengeId,
    answers: payload.answers,
    ipHash: ctx.ipHash,
    // 让 cookie 的 Secure 跟着本次请求的实际协议走：HTTP 部署下也能正常保存会话
    secureRequest: ctx.secure
  });

  if (!result.ok) {
    return sendJson(ctx.req, ctx.res, result.status, {
      error: result.code,
      message: result.message,
      remaining: result.remaining
    });
  }

  const headers = { "Cache-Control": "no-store" };
  if (result.cookie) headers["Set-Cookie"] = result.cookie;
  sendJson(ctx.req, ctx.res, 200, { verified: true, expiresIn: result.expiresIn }, headers);
});

// POST /api/gate/logout —— 主动结束会话（换人使用同一设备时用）
route("POST", "/api/gate/logout", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, { verified: false }, {
    "Set-Cookie": gate.clearCookie(ctx.secure),
    "Cache-Control": "no-store"
  });
});

/* ───────────────────────── 内测反馈 ─────────────────────────
 * 内测阶段最重要的输入渠道：用户不必注册、不必留联系方式也能提交。
 * 反馈只进后台队列，不会出现在公开列表里，因此不做内容预筛。
 * ---------------------------------------------------------- */

// POST /api/feedback  { body, contact?, cat? }
route("POST", "/api/feedback", async (ctx) => {
  if (!beta.FEEDBACK_ENABLED) {
    return sendJson(ctx.req, ctx.res, 403, { error: "feedback_disabled", message: "内测反馈入口已关闭" });
  }
  if (!requireGate(ctx)) return;

  const bucket = limit(`feedback:${ctx.ipHash}`, 5, 60 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const body = String(payload.body || "").trim();
  const contact = String(payload.contact || "").trim().slice(0, 120);
  const rawCat = String(payload.cat || "").trim();
  const cat = ["bug", "idea", "other"].includes(rawCat) ? rawCat : "other";

  if (body.length < 4) throw httpError(400, "feedback too short");
  if (body.length > beta.FEEDBACK_MAX) throw httpError(400, "feedback too long");

  const info = db.prepare(
    `INSERT INTO feedback (cat, body, contact, status, ip_hash, ua_hash, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(cat, body, contact || null, "open", ctx.ipHash, ctx.uaHash, Date.now());

  // 只保留最近 FEEDBACK_KEEP 条已处理反馈，避免这张表无限增长
  db.prepare(
    `DELETE FROM feedback WHERE status <> 'open' AND id NOT IN (
       SELECT id FROM feedback ORDER BY id DESC LIMIT ?
     )`
  ).run(beta.FEEDBACK_KEEP);

  sendJson(ctx.req, ctx.res, 201, { ok: true, id: info.lastInsertRowid });
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
  if (!requireGate(ctx)) return;

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
  if (!requireGate(ctx)) return;

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
  if (!requireGate(ctx)) return;

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

  // 先审后发同样适用于评论：一律 pending，人工通过后才出现在帖子下。
  // 为什么不做「命中规则才转人工、否则直接公开」：那属于发布后审核 ——
  // 一旦规则漏判，违规评论已经公开出去了，正是被处罚的那种模式。
  // comment_count 只在审核通过时 +1（见 applyCommentReview），因此这里不动。
  const info = db
    .prepare(
      `INSERT INTO comments (post_id, body, status, flag, ip_hash, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(postId, body, "pending", mod.flagged ? mod.flags.join(",") : null, ctx.ipHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { id: info.lastInsertRowid, status: "pending" });
});

// POST /api/reports  { postId, reason }
route("POST", "/api/reports", async (ctx) => {
  if (!requireGate(ctx)) return;

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
  // 管理鉴权是暴力破解的目标，因此单独限流；默认 15 分钟 10 次。
  // 内部工具批量审核时可以调高（ADMIN_RATE_LIMIT），但不设关闭开关。
  const authBucket = limit(`admin:${ctx.ipHash}`, ADMIN_RATE_LIMIT, 15 * 60 * 1000);
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

  const pendingPosts = one("SELECT COUNT(*) AS n FROM posts WHERE status='pending'");
  const pendingComments = one("SELECT COUNT(*) AS n FROM comments WHERE status='pending'");
  const openReports = one("SELECT COUNT(*) AS n FROM reports WHERE status='open'");

  // 队列最久等待时长：审核员最需要的一个信号。
  // 两条查询都走既有索引（(status, created_at, id)），且 LIMIT 1 直接取索引头部。
  const oldestPost = db.prepare(
    "SELECT created_at FROM posts WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get();
  const oldestComment = db.prepare(
    "SELECT created_at FROM comments WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get();
  const candidates = [oldestPost && oldestPost.created_at, oldestComment && oldestComment.created_at]
    .filter((v) => Number.isFinite(v) && v > 0);
  const oldestPendingAt = candidates.length ? Math.min(...candidates) : null;

  sendJson(ctx.req, ctx.res, 200, {
    pendingPosts,
    pendingComments,
    openReports,
    approvedPosts: one("SELECT COUNT(*) AS n FROM posts WHERE status='approved'"),
    pendingTotal: pendingPosts + pendingComments + openReports,
    oldestPendingAt,
    generatedAt: Date.now(),
    // 内测运营指标：还有多少反馈没处理、门禁是否开着、当前是哪个内测版本
    openFeedback: one("SELECT COUNT(*) AS n FROM feedback WHERE status='open'"),
    gateRequired: gate.ENABLED,
    gateInviteRequired: gate.INVITE_REQUIRED,
    betaVersion: beta.VERSION,
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

/**
 * 审核队列游标：`created_at.id`。队列按时间正序处理，用行值元组比较翻页，
 * 既不重复也不遗漏，且能吃到 (status, created_at, id) 这条既有索引。
 */
function parseQueueCursor(raw) {
  const [t, i] = String(raw || "").split(".");
  const createdAt = toInt(t, 0);
  const id = toInt(i, 0);
  return createdAt > 0 && id > 0 ? { createdAt, id } : null;
}

// GET /api/admin/queue?type=posts|comments&limit=&cursor=&q=
route("GET", "/api/admin/queue", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const type = ctx.query.get("type") === "comments" ? "comments" : "posts";
  const take = clamp(toInt(ctx.query.get("limit"), 50), 1, 100);
  const q = String(ctx.query.get("q") || "").trim().slice(0, 60);
  const cursor = parseQueueCursor(ctx.query.get("cursor"));

  if (type === "comments") {
    // 审核评论必须看到它挂在哪个帖子上，否则无法判断上下文。
    // LEFT JOIN 帖子仅用于取上下文，驱动表仍是 comments 且走 idx_comments_queue。
    const where = ["c.status = 'pending'"];
    const args = [];
    if (q) {
      where.push("(c.body LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')");
      args.push("%" + escapeLike(q) + "%", "%" + escapeLike(q) + "%");
    }
    const totalWhere = where.slice();
    const totalArgs = args.slice();
    if (cursor) {
      where.push("(c.created_at, c.id) > (?, ?)");
      args.push(cursor.createdAt, cursor.id);
    }

    const rows = db
      .prepare(
        `SELECT c.id, c.post_id, c.body, c.flag, c.created_at,
                p.body AS post_body, p.cat AS post_cat, p.status AS post_status
           FROM comments c LEFT JOIN posts p ON p.id = c.post_id
          WHERE ${where.join(" AND ")}
          ORDER BY c.created_at ASC, c.id ASC LIMIT ?`
      )
      .all(...args, take + 1);

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments c LEFT JOIN posts p ON p.id = c.post_id
          WHERE ${totalWhere.join(" AND ")}`
      )
      .get(...totalArgs).n;
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items[items.length - 1];
    return sendJson(ctx.req, ctx.res, 200, {
      type,
      items,
      total,
      nextCursor: hasMore && last ? `${last.created_at}.${last.id}` : null
    });
  }

  const where = ["status = 'pending'"];
  const args = [];
  if (q) {
    where.push("body LIKE ? ESCAPE '\\'");
    args.push("%" + escapeLike(q) + "%");
  }
  const totalWhere = where.slice();
  const totalArgs = args.slice();
  if (cursor) {
    where.push("(created_at, id) > (?, ?)");
    args.push(cursor.createdAt, cursor.id);
  }

  const rows = db
    .prepare(
      `SELECT id, cat, body, flag, created_at, like_count, comment_count
         FROM posts WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(...args, take + 1);

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${totalWhere.join(" AND ")}`)
    .get(...totalArgs).n;
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items[items.length - 1];
  sendJson(ctx.req, ctx.res, 200, {
    type,
    items,
    total,
    nextCursor: hasMore && last ? `${last.created_at}.${last.id}` : null
  });
});

const REVIEW = {
  approve: "approved",
  reject: "rejected",
  remove: "removed"
};

/**
 * 审核帖子。抽成函数后单条与批量走同一条路径，避免两处逻辑各写一遍慢慢漂移。
 * 下架时连带把该帖的待处理工单标记为已处理 —— 内容已经没了，工单再挂着只会误导。
 */
function applyPostReview(postId, action, ip) {
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post) return null;
  const next = REVIEW[action];

  const apply = db.transaction(() => {
    db.prepare("UPDATE posts SET status = ?, reviewed_at = ? WHERE id = ?")
      .run(next, Date.now(), postId);
    if (action === "remove") {
      db.prepare(
        "UPDATE reports SET status = 'actioned', resolved_at = ? WHERE post_id = ? AND status = 'open'"
      ).run(Date.now(), postId);
    }
  });
  apply();

  audit(`post.${action}`, postId, `from:${post.status}`, ip);
  bumpFeedCache(); // 通过/下架都会改变公开列表，立即失效缓存
  return { id: postId, status: next, from: post.status };
}

/**
 * 审核评论。计数必须跟着状态变化走：通过 +1，把已通过的评论驳回则 -1，
 * 否则 comment_count 会随着审核动作单向上漂，墙上显示的评论数就不可信了。
 */
function applyCommentReview(commentId, action, ip) {
  const comment = db.prepare("SELECT id, post_id, status FROM comments WHERE id = ?").get(commentId);
  if (!comment) return null;
  const next = action === "approve" ? "approved" : "rejected";
  const delta = (next === "approved" && comment.status !== "approved") ? 1
    : (next !== "approved" && comment.status === "approved") ? -1
    : 0;

  const apply = db.transaction(() => {
    db.prepare("UPDATE comments SET status = ? WHERE id = ?").run(next, commentId);
    if (delta) {
      db.prepare("UPDATE posts SET comment_count = MAX(0, comment_count + ?) WHERE id = ?")
        .run(delta, comment.post_id);
    }
  });
  apply();

  audit(`comment.${action}`, commentId, delta ? `post:${comment.post_id} delta:${delta}` : null, ip);
  // 评论数会出现在公开列表卡片上，计数变了就让列表缓存立即失效。
  if (delta) bumpFeedCache();
  return { id: commentId, status: next, commentCountDelta: delta };
}

for (const action of Object.keys(REVIEW)) {
  route("POST", `/api/admin/posts/:id/${action}`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const result = applyPostReview(toInt(ctx.params.id, 0), action, ctx.ip);
    if (!result) throw httpError(404, "post not found");
    sendJson(ctx.req, ctx.res, 200, result);
  });
}

for (const action of ["approve", "reject"]) {
  route("POST", `/api/admin/comments/:id/${action}`, (ctx) => {
    if (!requireAdmin(ctx)) return;
    const result = applyCommentReview(toInt(ctx.params.id, 0), action, ctx.ip);
    if (!result) throw httpError(404, "comment not found");
    sendJson(ctx.req, ctx.res, 200, result);
  });
}

// GET /api/admin/posts/:id —— 单帖详情（正文 + 全部评论 + 相关工单）
// 审核举报时需要在一个页面看全上下文，而不是来回翻列表。
route("GET", "/api/admin/posts/:id", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const postId = toInt(ctx.params.id, 0);
  const post = db
    .prepare(
      `SELECT id, cat, body, status, flag, like_count, comment_count, created_at, reviewed_at
         FROM posts WHERE id = ?`
    )
    .get(postId);
  if (!post) throw httpError(404, "post not found");

  const comments = db
    .prepare(
      `SELECT id, body, status, flag, created_at FROM comments
        WHERE post_id = ? ORDER BY id ASC LIMIT 500`
    )
    .all(postId);
  const reports = db
    .prepare(
      `SELECT id, reason, status, created_at FROM reports
        WHERE post_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(postId);

  sendJson(ctx.req, ctx.res, 200, {
    post: {
      id: post.id,
      cat: post.cat,
      body: post.body,
      status: post.status,
      flag: post.flag,
      likes: post.like_count,
      comments: post.comment_count,
      createdAt: post.created_at,
      reviewedAt: post.reviewed_at
    },
    comments: comments.map((c) => ({
      id: c.id, body: c.body, status: c.status, flag: c.flag, createdAt: c.created_at
    })),
    reports: reports.map((r) => ({
      id: r.id, reason: r.reason, status: r.status, createdAt: r.created_at
    }))
  });
});

// POST /api/admin/bulk  { type:'posts'|'comments', ids:number[], action }
// 一次事务处理多条，审核高峰期省掉「每条一个来回」的开销。
route("POST", "/api/admin/bulk", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const type = payload.type === "comments" ? "comments" : "posts";
  const action = String(payload.action || "").trim();
  const allowed = type === "posts" ? Object.keys(REVIEW) : ["approve", "reject"];
  if (!allowed.includes(action)) throw httpError(400, "invalid action");

  const ids = (Array.isArray(payload.ids) ? payload.ids : [])
    .map((v) => toInt(v, 0))
    .filter((v) => v > 0)
    .slice(0, 100);
  if (!ids.length) throw httpError(400, "empty ids");

  const updated = [];
  const skipped = [];
  const apply = type === "posts" ? applyPostReview : applyCommentReview;
  const run = db.transaction(() => {
    for (const id of ids) {
      const result = apply(id, action, ctx.ip);
      (result ? updated : skipped).push(id);
    }
  });
  run();

  sendJson(ctx.req, ctx.res, 200, { type, action, updated, skipped });
});

// GET /api/admin/audit?action=&limit= —— 审核操作留痕（合规与追责）
route("GET", "/api/admin/audit", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const take = clamp(toInt(ctx.query.get("limit"), 50), 1, 200);
  const action = String(ctx.query.get("action") || "").trim().slice(0, 40);
  // 不返回 ip_hash：留痕只需要「谁在什么时候做了什么」，而不是可追踪标识。
  const rows = action
    ? db.prepare(
        `SELECT id, action, target, note, created_at FROM audit_log
          WHERE action = ? ORDER BY id DESC LIMIT ?`
      ).all(action, take)
    : db.prepare(
        `SELECT id, action, target, note, created_at FROM audit_log
          ORDER BY id DESC LIMIT ?`
      ).all(take);
  const total = action
    ? db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action).n
    : db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  sendJson(ctx.req, ctx.res, 200, { items: rows, total });
});

// GET /api/admin/reports?status=open|actioned|dismissed|all&limit=
route("GET", "/api/admin/reports", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const status = ctx.query.get("status") || "open";
  const take = clamp(toInt(ctx.query.get("limit"), 100), 1, 200);

  // 工单必须能直接看到被举报内容，否则审核员只能凭一条理由盲判。
  // LEFT JOIN 只按主键取上下文，驱动表仍是 reports 且走 idx_reports_status。
  const base = `SELECT r.id, r.post_id, r.comment_id, r.reason, r.status,
                       r.created_at, r.resolved_at,
                       p.body AS post_body, p.cat AS post_cat, p.status AS post_status,
                       c.body AS comment_body
                  FROM reports r
                  LEFT JOIN posts p ON p.id = r.post_id
                  LEFT JOIN comments c ON c.id = r.comment_id`;

  const rows = status === "all"
    ? db.prepare(`${base} ORDER BY r.id DESC LIMIT ?`).all(take)
    : db.prepare(`${base} WHERE r.status = ? ORDER BY r.id DESC LIMIT ?`).all(status, take);
  const total = status === "all"
    ? db.prepare("SELECT COUNT(*) AS n FROM reports").get().n
    : db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = ?").get(status).n;

  sendJson(ctx.req, ctx.res, 200, { items: rows, total, status });
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
      // 同一帖子可能积压多条工单：内容下架即全部结案，避免工单列表残留。
      db.prepare(
        "UPDATE reports SET status = 'actioned', resolved_at = ? WHERE post_id = ? AND status = 'open'"
      ).run(Date.now(), report.post_id);
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

// GET /api/admin/feedback?status=open|done|dismissed|all&limit= —— 内测反馈队列
//
// 路由顺序提醒（历史 bug，值得留在这里）：管理端曾经把列表路由
// `/api/admin/identities` 注册在参数路由 `/api/admin/identity/:id` 之后，
// 而 `:id` 编译出的正则 ([^/]+) 会把字面量 "identities" 也吃掉 ——
// 列表请求被参数路由接管，结果只返回一条记录。这里两条路由的字面量前缀
// 完全不同（feedback / 无参数路由），不存在该问题；新增参数路由时请务必
// 先注册字面量路由。
route("GET", "/api/admin/feedback", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const status = ctx.query.get("status") || "open";
  const take = clamp(toInt(ctx.query.get("limit"), 50), 1, 200);
  const rows = status === "all"
    ? db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT ?").all(take)
    : db.prepare("SELECT * FROM feedback WHERE status = ? ORDER BY id DESC LIMIT ?").all(status, take);
  const total = status === "all"
    ? db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n
    : db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = ?").get(status).n;
  sendJson(ctx.req, ctx.res, 200, { items: rows, total, status });
});

// POST /api/admin/feedback/:id/resolve  { action: 'done' | 'dismiss' }
// 反馈不改变公开内容，因此不需要 bumpFeedCache。
route("POST", "/api/admin/feedback/:id/resolve", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = toInt(ctx.params.id, 0);
  if (id <= 0) throw httpError(400, "invalid feedback id");

  let action = "dismiss";
  try {
    const payload = await readJson(ctx.req);
    if (payload && payload.action === "done") action = "done";
  } catch { /* 无请求体时按 dismiss 处理 */ }

  const row = db.prepare("SELECT id, status FROM feedback WHERE id = ?").get(id);
  if (!row) throw httpError(404, "feedback not found");

  db.prepare("UPDATE feedback SET status = ?, resolved_at = ? WHERE id = ?")
    .run(action === "done" ? "done" : "dismissed", Date.now(), id);
  audit(`feedback.${action}`, id, null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { id, status: action === "done" ? "done" : "dismissed" });
});

// POST /api/admin/shutdown —— 受控的优雅停机入口
//
// 为什么需要它（而不是只能靠信号）：
//   Windows 上 Node 对 SIGTERM 的支持有限 —— child.kill("SIGTERM") 走的是直接终止
//   进程，JS 里的信号处理器根本不会执行，于是「干净退出标记」写不进去，
//   下次启动会误判为非优雅退出并触发全量点赞校准。
//   生产（Linux + systemd）信号路径是正常的，但这个接口让收尾逻辑在任何平台
//   都能被验证，也给运维多一个不依赖信号的重启方式。
route("POST", "/api/admin/shutdown", (ctx) => {
  if (!requireAdmin(ctx)) return;
  audit("server.shutdown", null, "manual", ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, message: "正在优雅停机" });
  // 先把响应发出去，再收尾，避免调用方拿到连接中断
  setTimeout(() => shutdown("ADMIN"), 150);
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

/* ───────────────────────────── 假的 /admin ───────────────────────────── */

/**
 * `/admin` 上的钓鱼页。
 *
 * 真后台挪到了 `/houtai/`，这里放一个"看起来像被识破"的一行页面：
 * 扫描器、好奇的路人、拿着旧书签的人都只会看到这句话，不会看到控制台的任何结构。
 *
 * 顺带说清楚定位：这**不是安全措施**，只是降噪。真正的防线永远是
 *   1) `ADMIN_TOKEN` 校验（所有 /api/admin/* 都强制）、
 *   2) 反代层限制来源（推荐 SSH 隧道，别把后台暴露在公网）。
 */
const DECOY_HTML = [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>404</title>",
  '<meta name="robots" content="noindex,nofollow">',
  "<style>",
  "html,body{height:100%;margin:0}",
  "body{display:grid;place-items:center;background:#fff;color:#1d1d1f;",
  'font-family:"SF Pro Text","Helvetica Neue",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}',
  "p{margin:0;padding:24px;text-align:center;font-size:clamp(22px,5vw,46px);",
  "font-weight:600;letter-spacing:-.01em;line-height:1.3}",
  "</style>",
  "</head>",
  "<body><p>你以为我会傻到这种程度？</p></body>",
  "</html>",
  ""
].join("\n");

function serveDecoy(req, res) {
  finish(req, res, 200, Buffer.from(DECOY_HTML), {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache"
  });
}

async function serveStatic(ctx) {
  const { req, res } = ctx;
  let rel = decodeURIComponent(ctx.pathname);
  if (rel === "/") rel = "/" + INDEX_FILE;

  // 后台的真实地址是 /houtai/（单文件、无构建依赖，固定从 server/public 提供，
  // 不受 WEB_ROOT 影响 —— 因为 WEB_ROOT 生产上指向 web/dist）。
  // 老路径 /admin 一律给钓鱼页；页面自身仍靠 ADMIN_TOKEN 调管理接口，
  // 真正的防线是「反代层限制来源」+「管理接口令牌校验」。
  const isDecoy = rel === "/admin" || rel === "/admin/" || rel === "/admin.html";
  if (isDecoy) return serveDecoy(req, res);

  const isAdminPage = rel === "/houtai" || rel === "/houtai/" || rel === "/houtai/index.html";
  let filePath;
  if (isAdminPage) {
    filePath = path.join(SERVER_ROOT, "public", "admin.html");
  } else {
    filePath = path.join(WEB_ROOT, rel);
    if (!filePath.startsWith(WEB_ROOT + path.sep)) throw httpError(403, "forbidden");
  }

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
  // Vite 产物文件名带内容哈希（index-CaUYiDMA.js / index-t4MySId-.js）：内容变了
  // 文件名就变，因此可以放心用「一年 + immutable」，浏览器不再发条件请求；
  // 没带哈希的静态资源（favicon 等）保守用一天。
  const hashed = /[-.][0-9A-Za-z_-]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|avif|svg)$/.test(filePath);
  const asset = /\.(css|js|png|jpe?g|webp|avif|svg|woff2?|ico)$/i.test(filePath);
  const headers = {
    "Content-Type": type,
    "Cache-Control": hashed ? "public, max-age=31536000, immutable"
      : asset ? "public, max-age=86400"
      : "no-cache",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString()
  };

  const isText = /^(text\/|application\/(json|javascript)|image\/svg)/.test(type);
  if (isText && stat.size < 2 * 1024 * 1024) {
    // 文本产物按 etag 缓存压缩结果：同一份 JS/CSS 只压一次
    return sendBuffer(req, res, 200, fs.readFileSync(filePath), headers, etag);
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
    /**
     * 本次请求是否走 HTTPS —— 决定门禁会话 cookie 要不要带 Secure。
     * 直接 TLS 看 socket；经过反代时看 X-Forwarded-Proto（仅在 TRUST_PROXY=1 时采信，
     * 与 clientIp 的信任边界保持一致）。
     */
    secure: Boolean(req.socket && req.socket.encrypted)
      || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"),
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
    return await serveStatic(ctx);
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

/**
 * 连接层调优（低配机器上很实际的几项）：
 *   - keepAliveTimeout 65s：高于常见反代（Caddy/Nginx 默认 60s）的空闲超时，
 *     避免反代复用连接时恰好撞上源站关闭连接，产生偶发 502；
 *   - headersTimeout 必须大于 keepAliveTimeout，否则 Node 会直接报错退出；
 *   - requestTimeout 30s：请求体很小，超过这个时间的连接基本是慢速攻击，
 *     让它自然断开，不占用单核。
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  console.log(`[up] 表白墙服务（${beta.NAME} ${beta.VERSION}）http://${HOST}:${PORT}`
    + `（端口来自 ${PORT_SOURCE}）`);
  if (ENV_LOADED) console.log(`[env] 已从 ${ENV_FILE} 读取 ${ENV_LOADED} 项配置`);
  console.log(`[up] 静态根目录 ${WEB_ROOT}`);
  console.log(`[up] 数据库 ${db.DB_PATH}（页缓存 ${db.CACHE_MB}MB）`);
  console.log(`[up] 内测门禁 ${gate.ENABLED ? "开启" : "关闭"}`
    + `（邀请码 ${gate.INVITE_REQUIRED ? "已配置" : "未配置"}）`);

  // 前端产物缺失时大声提醒：面板部署最容易漏的一步（没有 shell 跑不了 build）。
  // 没有它页面会是 404 或半成品，而日志里除了这一条没有任何线索。
  const homeFile = path.join(WEB_ROOT, INDEX_FILE);
  if (!fs.existsSync(homeFile)) {
    console.warn(`[warn] 前端产物不存在：${homeFile}`);
    console.warn("[warn] 本地开发执行 `npm run build`；面板部署重跑一次 `npm install`"
      + "（package.json 的 prepare 钩子会自动构建），或把 web/dist 一起部署上去");
  }
});

/* ─────────────────────────── 优雅退出 ─────────────────────────── */

let shuttingDown = false;

/**
 * 优雅停机。
 *
 * 刻意**不调用 process.exit()**，而是设置 process.exitCode 后让事件循环自然结束：
 * 强制退出会在 better-sqlite3 的语句对象尚未被回收时拆掉整个环境，
 * 偶发触发原生断言（RemoveEnvironmentCleanupHook / Statement 析构）导致
 * 进程以 SIGABRT(134) 结束 —— 那样 systemd 会认为服务异常退出，
 * 而我们精心写的「干净退出标记」也就白写了。
 *
 * 事件循环能被自然排空：HTTP server 已 close、点赞定时器与维护定时器都是 unref；
 * 内测版没有任何出网请求（门禁与反馈都在本进程内完成），因此不会有悬挂的 socket。
 * 留一个兜底计时器防极端情况挂住。
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[down] 收到 ${signal}，正在收尾…`);
  clearInterval(likeSweeper);
  flushDirtyLikes();

  server.close(() => {
    db.shutdown(); // 标记干净退出 + optimize + WAL 截断
    process.exitCode = 0;
    console.log("[down] 收尾完成，等待进程自然退出");
  });

  // 兜底：正常应在毫秒级排空；10 秒还没退出说明有句柄泄漏，此时才强制退出
  setTimeout(() => {
    console.error("[down] 收尾超时，强制退出");
    process.exit(0);
  }, 10000).unref();
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
