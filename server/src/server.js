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
 * v1.0.0 说明：
 *   - **账号体系**：邮箱验证码登录（Cloudflare Email Service 发送，见 email.js），
 *     对外唯一标识是 uuid；学校在注册时选定且不可更改；
 *   - **论坛**：署名讨论区（昵称/头衔/等级），与匿名表白墙刻意区分；
 *   - **好友与私信**：请求—同意式加好友（互相添加即刻成为好友），仅好友可私信；
 *   - **头衔与等级**：头衔由后台自定义（可自动按等级授予），等级由经验推导；
 *   - 公告栏由后台维护，前端通过 GET /api/site 获取。
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
const { classify, classifyNickname } = require("./moderation");
const { limit } = require("./rate-limit");
const config = require("./config");
const users = require("./users");
const email = require("./email");
const forum = require("./forum");
const social = require("./social");
const announce = require("./announce");
const afdian = require("./afdian");

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
/** 评论字数上限（表白正文已无上限，评论仍留一个防止刷屏的长度） */
const COMMENT_MAX = Number(process.env.COMMENT_MAX || 300);
const FEEDBACK_MAX = Math.max(20, Math.min(4000, Number(process.env.FEEDBACK_MAX || 800)));
const FEEDBACK_KEEP = Math.max(100, Number(process.env.FEEDBACK_KEEP || 2000));
const LIKE_FLUSH_MS = Number(process.env.LIKE_FLUSH_MS || 1500);
const ADMIN_RATE_LIMIT = Number(process.env.ADMIN_RATE_LIMIT || 10);
/** 已鉴权的管理请求上限（5 分钟窗口）。只防脚本刷库，不该掐正常审核操作。 */
const ADMIN_API_RATE_LIMIT = Number(process.env.ADMIN_API_RATE_LIMIT || 600);
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

// 账号体系需要用同一个密钥做验证码 HMAC（与会话 token 的 SHA-256 不同，
// 这里要的是「不可离线爆破」）。复用 IP_HASH_SECRET，避免再多一个必填项。
users.configure({ secret: IP_SECRET });

// 生产环境的邮件通道自检：不配置就等于「用户收不到验证码」，
// 必须在启动日志里说清楚，而不是等第一个用户登录失败才发现。
if (IS_PROD && !config.EMAIL.configured) {
  console.warn("[warn] 未配置 Cloudflare 邮件通道（CF_ACCOUNT_ID / CF_EMAIL_TOKEN / CF_EMAIL_FROM）："
    + "邮箱验证码不会外发，只会写入 server/data/outbox/ 与服务端日志");
}
// 学校名单为空 = 没人能完成注册，属于必须让运维看见的配置缺失
if (!users.schoolList().length) {
  console.warn("[warn] 学校名单为空：请到后台 /houtai/ 的「学校管理」添加学校，否则新用户无法完成注册");
}

/* ────────────────────────────── 工具 ────────────────────────────── */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  // 不收录：站内是校园用户生成内容，被搜索引擎快照下来对学生没有好处。
  // 与 index.html 的 <meta name="robots"> 双保险（meta 只管前台页，响应头覆盖 /houtai/）。
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  // 全站没有任何第三方脚本：CSP 收紧到 'self'，不为外部来源开口子。
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

/* ─────────────────────── 登录 / 限流 小工具 ─────────────────────── */

/**
 * 写操作与个人数据的统一入口：必须有有效会话。
 *
 * 与旧版「内测门禁」的区别：不再是共享口令 + 答题，而是真账号。
 * 账号带来两个直接好处：责任可追溯（后台能看到是谁发的），
 * 以及点赞/好友/私信这类「属于某个人」的状态终于有了主体。
 *
 * @returns {object|null} 用户行；null 表示已响应 401，调用方直接 return
 */
function requireLogin(ctx) {
  if (ctx.user) return ctx.user;
  sendJson(ctx.req, ctx.res, 401, { error: "login_required", message: "请先登录" });
  return null;
}

/** 被禁言/封禁的账号不能写内容（浏览不受影响） */
function requireWritable(ctx, user) {
  if (user.status === "muted") {
    sendJson(ctx.req, ctx.res, 403, { error: "muted", message: "账号已被禁言，暂时无法发布内容" });
    return false;
  }
  if (user.status === "banned") {
    sendJson(ctx.req, ctx.res, 403, { error: "account_banned", message: "该账号已被封禁" });
    return false;
  }
  return true;
}

/** 点赞/评论这类「属于用户」的行为用它做去重键：换设备仍然是同一个人 */
function actorKey(ctx) {
  return ctx.user ? "u:" + ctx.user.uuid : "ip:" + ctx.ipHash;
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
    // 版本随健康检查下发：前端探针、监控与发版核对共用同一个值
    version: config.VERSION
  });
});

/* ───────────────────────── 站点信息 / 账号 ─────────────────────────
 * 公开接口（不需要登录）：站点配置、公告、学校名单。
 * 前端首屏只打一个 /api/site 就能把「版本、站名、公告、功能开关」全拿到。
 * ------------------------------------------------------------------ */

// GET /api/site —— 公开站点信息 + 首页公告
route("GET", "/api/site", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, Object.assign(config.publicConfig(), {
    announcements: announce.listActive()
  }));
});

// GET /api/schools —— 注册时可选的学校（后台维护的启用名单）
route("GET", "/api/schools", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, { items: users.schoolList() });
});

/* ───────────────────────── 爱发电赞助回调 ─────────────────────────
 * 爱发电在订单支付后 POST 到这里（form-urlencoded：params=<JSON>&sign=<md5>）。
 *
 * 三个必须做对的地方：
 *   1. **必须回 {"ec":200,"em":""}**，否则平台会一直重试；
 *   2. 签名按官方算法校验（token 未配置时不接受任何回调，避免被伪造刷奖）；
 *   3. 幂等交给 out_trade_no 唯一约束 —— 重试是常态，不是异常。
 *
 * 注意：这里读的是**原始 body**，不能走 readJson（回调是表单编码而不是 JSON）。
 * ------------------------------------------------------------------ */
route("POST", "/api/afdian/webhook", async (ctx) => {
  if (!config.AFDIAN.enabled) {
    return sendJson(ctx.req, ctx.res, 404, { ec: 404, em: "afdian not configured" });
  }

  let raw = "";
  try {
    const buf = await readBody(ctx.req);
    raw = buf.toString("utf8");
  } catch {
    return sendJson(ctx.req, ctx.res, 200, { ec: 413, em: "payload too large" });
  }

  const parsed = afdian.parseWebhook(raw, ctx.req.headers["content-type"]);
  if (!parsed.ok) {
    afdian.rememberAttempt({ ok: false, reason: parsed.reason, raw: raw.slice(0, 500), ip: ctx.ip });
    audit("afdian.webhook_rejected", null, parsed.reason, ctx.ip);
    console.warn(`[afdian] 回调被拒：${parsed.reason}；原文（截断）：${raw.slice(0, 300)}`);
    return sendJson(ctx.req, ctx.res, 200, { ec: 403, em: parsed.reason });
  }

  const event = parsed.event || {};
  const order = event.order || null;
  if (!order || !order.out_trade_no) {
    afdian.rememberAttempt({ ok: false, reason: "no_order_in_event", raw: raw.slice(0, 500), ip: ctx.ip });
    return sendJson(ctx.req, ctx.res, 200, { ec: 200, em: "" });
  }

  const result = afdian.handleOrder(order, "webhook");
  afdian.rememberAttempt({
    ok: true,
    order: order.out_trade_no,
    duplicated: Boolean(result.duplicated),
    matched: Boolean(result.matched),
    reward: result.reward || "",
    ip: ctx.ip
  });

  if (!result.duplicated && result.matched) {
    audit("afdian.reward", order.out_trade_no, result.reward || "", ctx.ip);
    console.log(`[afdian] 订单 ${order.out_trade_no} 已匹配：${result.reward || "（未配置发奖）"}`);
  }

  // 无论有没有匹配到人都回 200：匹配是「我们这边的事」，不该让平台反复重试
  sendJson(ctx.req, ctx.res, 200, { ec: 200, em: "" });
});

/* ───────────────────────── 邮箱验证码登录 ─────────────────────────
 * 三步：
 *   1. POST /api/auth/code     发 6 位验证码（Cloudflare Email Service）
 *   2. POST /api/auth/verify   校验：老用户直接建会话；新用户拿一次性注册令牌
 *   3. POST /api/auth/register 填昵称 + 学校，建号（学校写死后不可改）
 * ---------------------------------------------------------------- */

// POST /api/auth/code  { email }
route("POST", "/api/auth/code", async (ctx) => {
  const payload = await readJson(ctx.req);
  const emailAddr = users.normalizeEmail(payload.email);

  if (!users.isValidEmail(emailAddr)) {
    return sendJson(ctx.req, ctx.res, 400, { error: "invalid_email", message: "邮箱格式不正确" });
  }

  // 两层限流：按 IP 防扫号，按邮箱防轰炸同一个人
  const ipBucket = limit(`auth-code-ip:${ctx.ipHash}`, 10, 10 * 60 * 1000);
  if (!ipBucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: ipBucket.retryAfter });
  }
  const mailBucket = limit(`auth-code-mail:${emailAddr}`, config.CODE_HOURLY_MAX, 60 * 60 * 1000);
  if (!mailBucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: mailBucket.retryAfter });
  }

  // 重发间隔：避免连点造成「收件箱里 5 封验证码，不知道填哪封」
  const last = users.lastCodeAt(emailAddr);
  if (last && Date.now() - last < config.CODE_RESEND_SEC * 1000) {
    return sendJson(ctx.req, ctx.res, 429, {
      error: "rate_limited",
      retryAfter: Math.ceil((config.CODE_RESEND_SEC * 1000 - (Date.now() - last)) / 1000)
    });
  }

  const existing = users.findByEmail(emailAddr);
  if (existing && existing.status === "banned") {
    return sendJson(ctx.req, ctx.res, 403, { error: "account_banned", message: "该账号已被封禁" });
  }

  const { code, ttlSeconds } = users.issueCode(emailAddr, { ipHash: ctx.ipHash });
  const mail = email.codeMail({
    code,
    siteName: config.SITE_NAME,
    ttlMinutes: Math.round(ttlSeconds / 60),
    purpose: existing ? "login" : "register"
  });

  const sent = await email.sendMail({
    to: emailAddr,
    subject: mail.subject,
    html: mail.html,
    text: mail.text
  });

  // 发信失败也要把验证码留在服务端（outbox + 日志），否则用户彻底卡死；
  // 但响应里要如实告诉前端「邮件没发出去」，不能假装成功。
  const body = { ok: true, expiresIn: ttlSeconds, delivered: Boolean(sent.ok) };
  if (config.CODE_ECHO) body.devCode = code;

  sendJson(ctx.req, ctx.res, 200, body, { "Cache-Control": "no-store" });
});

// POST /api/auth/verify  { email, code }
route("POST", "/api/auth/verify", async (ctx) => {
  const bucket = limit(`auth-verify:${ctx.ipHash}`, 20, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const emailAddr = users.normalizeEmail(payload.email);
  if (!users.isValidEmail(emailAddr)) {
    return sendJson(ctx.req, ctx.res, 400, { error: "invalid_email" });
  }

  const result = users.verifyCode(emailAddr, payload.code);
  if (!result.ok) {
    const status = result.error === "code_expired" ? 410 : 401;
    return sendJson(ctx.req, ctx.res, status, {
      error: result.error,
      message: result.error === "code_expired" ? "验证码已失效，请重新获取" : "验证码不正确",
      remaining: result.remaining
    });
  }

  const user = users.findByEmail(emailAddr);

  // 新用户：不直接建号 —— 还必须选学校、起昵称。用一次性令牌承接上一步。
  if (!user) {
    const issued = users.issueRegisterToken(emailAddr, { ipHash: ctx.ipHash });
    return sendJson(ctx.req, ctx.res, 200, {
      needProfile: true,
      token: issued.token,
      email: emailAddr
    }, { "Cache-Control": "no-store" });
  }

  if (user.status === "banned") {
    return sendJson(ctx.req, ctx.res, 403, { error: "account_banned", message: "该账号已被封禁" });
  }

  const session = users.createSession(user.id, { ipHash: ctx.ipHash, uaHash: ctx.uaHash });
  users.touchLogin(user.id);

  sendJson(ctx.req, ctx.res, 200, {
    user: users.publicUser(users.findById(user.id), { self: true, stats: users.statsFor(user.id) })
  }, {
    "Set-Cookie": users.sessionCookie(session.token, ctx.secure),
    "Cache-Control": "no-store"
  });
});

// POST /api/auth/register  { token, nickname, school, avatar? }
route("POST", "/api/auth/register", async (ctx) => {
  const bucket = limit(`auth-register:${ctx.ipHash}`, 10, 60 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  // 先校验、后消费：中间任何一步失败（昵称不合规、学校不对）都不该让用户重走一遍验证码
  const pending = users.peekRegisterToken(payload.token);
  if (!pending.ok) {
    return sendJson(ctx.req, ctx.res, 400, { error: "invalid_token", message: "注册凭证已失效，请重新获取验证码" });
  }

  const nickname = String(payload.nickname || "").trim();
  if (nickname.length < users.NICKNAME_MIN || nickname.length > users.NICKNAME_MAX) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "nickname_length",
      message: `昵称需要 ${users.NICKNAME_MIN}–${users.NICKNAME_MAX} 个字`
    });
  }

  // 昵称本地预审：命中违禁词直接拒绝（内容命中才转人工队列，昵称不行 ——
  // 昵称会在全站到处出现，让它先进队列等于先污染再收拾）。
  const nickMod = classifyNickname(nickname);
  if (nickMod.rejected) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "nickname_rejected",
      message: "昵称包含不允许使用的词，请换一个",
      flags: nickMod.flags
    });
  }

  const school = users.normalizeSchool(payload.school);
  if (!users.schoolList().length) {
    return sendJson(ctx.req, ctx.res, 409, { error: "schools_unavailable", message: "管理员尚未配置学校名单" });
  }
  if (!users.isValidSchool(school)) {
    return sendJson(ctx.req, ctx.res, 400, { error: "invalid_school", message: "请从列表中选择学校" });
  }

  if (users.findByEmail(pending.email)) {
    return sendJson(ctx.req, ctx.res, 409, { error: "already_registered", message: "该邮箱已注册，请直接登录" });
  }

  const avatar = users.AVATARS.includes(payload.avatar) ? payload.avatar : "";
  const user = users.createUser({
    email: pending.email,
    nickname,
    school,
    avatar,
    ipHash: ctx.ipHash,
    uaHash: ctx.uaHash
  });

  // 昵称预审只在「疑似」时才留痕：这里已经拒绝了明确命中，走到这说明是干净的，
  // 但保留一个轻量标记便于后台发现「批量注册的相似昵称」。
  if (nickMod.flagged) users.setNicknameFlag(user.id, nickMod.flags.join(","));

  // 账号已经建好，令牌到此才作废（重放会被拒）
  users.consumeRegisterToken(payload.token);

  const session = users.createSession(user.id, { ipHash: ctx.ipHash, uaHash: ctx.uaHash });
  sendJson(ctx.req, ctx.res, 201, {
    user: users.publicUser(users.findById(user.id), { self: true, stats: users.statsFor(user.id) })
  }, {
    "Set-Cookie": users.sessionCookie(session.token, ctx.secure),
    "Cache-Control": "no-store"
  });
});

// POST /api/auth/logout
route("POST", "/api/auth/logout", (ctx) => {
  if (ctx.token) users.destroySession(ctx.token);
  sendJson(ctx.req, ctx.res, 200, { ok: true }, {
    "Set-Cookie": users.clearSessionCookie(ctx.secure),
    "Cache-Control": "no-store"
  });
});

// GET /api/auth/me —— 前端首屏判断登录态
route("GET", "/api/auth/me", (ctx) => {
  sendJson(ctx.req, ctx.res, 200, {
    user: ctx.user
      ? users.publicUser(ctx.user, { self: true, stats: users.statsFor(ctx.user.id) })
      : null
  }, { "Cache-Control": "no-store" });
});

// PATCH /api/me —— 账号个性化（昵称/头像/简介）。**不接受 school**，学校不可更改。
route("PATCH", "/api/me", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const bucket = limit(`me-update:${user.id}`, 10, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);

  if (Object.prototype.hasOwnProperty.call(payload, "nickname")) {
    const nickname = String(payload.nickname || "").trim();
    const nickMod = classifyNickname(nickname);
    if (nickMod.rejected) {
      return sendJson(ctx.req, ctx.res, 400, {
        error: "nickname_rejected",
        message: "昵称包含不允许使用的词，请换一个",
        flags: nickMod.flags
      });
    }
  }

  const result = users.updateProfile(user.id, payload);
  if (!result.ok) {
    const messages = {
      nickname_length: `昵称需要 ${users.NICKNAME_MIN}–${users.NICKNAME_MAX} 个字`,
      nickname_cooldown: "昵称修改过于频繁，请稍后再试",
      invalid_avatar: "头像不可用",
      bio_too_long: `简介最多 ${users.BIO_MAX} 个字`
    };
    const status = result.error === "nickname_cooldown" ? 429 : 400;
    return sendJson(ctx.req, ctx.res, status, {
      error: result.error,
      message: messages[result.error] || "修改失败",
      retryAfter: result.retryAfter
    });
  }

  const fresh = users.findById(user.id);
  if (Object.prototype.hasOwnProperty.call(payload, "nickname")) {
    users.setNicknameFlag(user.id, null); // 改名成功即清掉旧标记
  }
  sendJson(ctx.req, ctx.res, 200, {
    user: users.publicUser(fresh, { self: true, stats: users.statsFor(user.id) })
  });
});

/* ───────────────────────── 意见反馈 ─────────────────────────
 * 用户不必留联系方式也能提交；登录用户会带上 user_id 便于回访。
 * 反馈只进后台队列，不会出现在公开列表里，因此不做内容预筛。
 * ---------------------------------------------------------- */

// POST /api/feedback  { body, contact?, cat? }
route("POST", "/api/feedback", async (ctx) => {
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
  if (body.length > FEEDBACK_MAX) throw httpError(400, "feedback too long");

  const info = db.prepare(
    `INSERT INTO feedback (user_id, cat, body, contact, status, ip_hash, ua_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(ctx.user ? ctx.user.id : null, cat, body, contact || null, "open", ctx.ipHash, ctx.uaHash, Date.now());

  // 只保留最近 FEEDBACK_KEEP 条已处理反馈，避免这张表无限增长
  db.prepare(
    `DELETE FROM feedback WHERE status <> 'open' AND id NOT IN (
       SELECT id FROM feedback ORDER BY id DESC LIMIT ?
     )`
  ).run(FEEDBACK_KEEP);

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
  const user = requireLogin(ctx);
  if (!user) return;
  if (!requireWritable(ctx, user)) return;

  const bucket = limit(`post:${user.id}`, 5, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const cat = cleanCat(payload.cat);
  const body = String(payload.body || "").trim();

  if (!cat) throw httpError(400, "invalid category");
  // **取消字数上限**：只要求非空。真正的边界由 MAX_BODY（请求体上限）兜底，
  // 不再对「说了多少话」做产品层面的限制。
  if (!body.length) {
    return sendJson(ctx.req, ctx.res, 400, { error: "empty", message: "内容不能为空" });
  }

  const mod = classify(body);
  const info = db
    .prepare(
      `INSERT INTO posts (user_id, cat, body, status, flag, ip_hash, ua_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(user.id, cat, body, "pending", mod.flagged ? mod.flags.join(",") : null, ctx.ipHash, ctx.uaHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { id: info.lastInsertRowid, status: "pending" });
});

// POST /api/posts/:id/like —— 幂等切换（同一个人再点即取消）
route("POST", "/api/posts/:id/like", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const bucket = limit(`like:${user.id}`, 200, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const postId = toInt(ctx.params.id, 0);
  const post = db.prepare("SELECT id, status, user_id FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  const actor = actorKey(ctx);
  // 别名别用 SQL 关键字：这里原来写成 `SELECT 1 AS on`，`ON` 是保留字，
  // 于是每次点赞都 `SqliteError: near "on": syntax error`（500）。
  const existing = db
    .prepare("SELECT 1 AS hit FROM likes WHERE post_id = ? AND actor = ?")
    .get(postId, actor);

  const toggle = db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM likes WHERE post_id = ? AND actor = ?").run(postId, actor);
    } else {
      db.prepare("INSERT INTO likes (post_id, actor, created_at) VALUES (?,?,?)")
        .run(postId, actor, Date.now());
    }
  });
  toggle();

  queueLikeCount(postId); // 计数异步批量回写
  const likes = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").get(postId).n;

  // 被点赞的人涨经验：自己点自己不算
  if (!existing && post.user_id && post.user_id !== user.id) {
    users.addExp(post.user_id, users.EXP.like_received);
  }

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
  const user = requireLogin(ctx);
  if (!user) return;
  if (!requireWritable(ctx, user)) return;

  const bucket = limit(`comment:${user.id}`, 30, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const postId = toInt(ctx.params.id, 0);
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  const payload = await readJson(ctx.req);
  const body = String(payload.body || "").trim();
  if (body.length < 1 || body.length > COMMENT_MAX) throw httpError(400, "invalid length");

  const mod = classify(body);

  // 先审后发同样适用于评论：一律 pending，人工通过后才出现在帖子下。
  // 为什么不做「命中规则才转人工、否则直接公开」：那属于发布后审核 ——
  // 一旦规则漏判，违规评论已经公开出去了，正是被处罚的那种模式。
  // comment_count 只在审核通过时 +1（见 applyCommentReview），因此这里不动。
  const info = db
    .prepare(
      `INSERT INTO comments (post_id, user_id, body, status, flag, ip_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(postId, user.id, body, "pending", mod.flagged ? mod.flags.join(",") : null, ctx.ipHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { id: info.lastInsertRowid, status: "pending" });
});

// POST /api/reports  { postId, reason }
route("POST", "/api/reports", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const bucket = limit(`report:${user.id}`, 10, 60 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const postId = toInt(payload.postId, 0);
  const reason = String(payload.reason || "").trim().slice(0, 200);
  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(postId);
  if (!post || post.status !== "approved") throw httpError(404, "post not found");

  // 同一个人对同一帖只记一次工单：避免重复举报把队列刷爆（也省一次写）
  const dup = db
    .prepare("SELECT id FROM reports WHERE post_id = ? AND reporter_id = ? AND status = 'open' LIMIT 1")
    .get(postId, user.id);
  if (dup) return sendJson(ctx.req, ctx.res, 200, { ok: true, duplicated: true });

  db.prepare("INSERT INTO reports (post_id, reporter_id, reason, ip_hash, created_at) VALUES (?,?,?,?,?)")
    .run(postId, user.id, reason || null, ctx.ipHash, Date.now());

  sendJson(ctx.req, ctx.res, 201, { ok: true });
});

/* ───────────────────────── 用户主页 / 好友 / 私信 ─────────────────────────
 * 这三块共享同一个「对外用户对象」（users.publicUser）：昵称、头像、学校、
 * 头衔、等级。展示顺序由前端固定为「学校 → 头衔 → 等级」，服务端只给数据。
 * ---------------------------------------------------------------------- */

/** 把「用户行 + 关系」组装成主页需要的形状 */
function profilePayload(viewer, target) {
  return {
    user: users.publicUser(target, { stats: users.statsFor(target.id) }),
    relation: social.relationFor(viewer ? viewer.id : null, target.id)
  };
}

// GET /api/users/:uuid —— 他人主页（未登录也能看：浏览不需要账号）
route("GET", "/api/users/:uuid", (ctx) => {
  const target = users.findByUuid(ctx.params.uuid);
  if (!target || target.status === "banned") throw httpError(404, "user not found");
  sendJson(ctx.req, ctx.res, 200, profilePayload(ctx.user, target), { "Cache-Control": "no-store" });
});

// POST /api/users/:uuid/block —— 拉黑（解除好友 + 拒收私信）
route("POST", "/api/users/:uuid/block", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  const result = social.blockUser(user.id, ctx.params.uuid);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: "操作失败" });
  audit("user.block", ctx.params.uuid, null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true });
});

// POST /api/users/:uuid/unblock
route("POST", "/api/users/:uuid/unblock", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  const result = social.unblockUser(user.id, ctx.params.uuid);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: "操作失败" });
  sendJson(ctx.req, ctx.res, 200, { ok: true });
});

/* ───────────────────────────── 论坛 ───────────────────────────── */

// GET /api/forum/threads?board=&sort=new|hot&cursor=&limit=
route("GET", "/api/forum/threads", (ctx) => {
  if (!config.FEATURES.forum) return sendJson(ctx.req, ctx.res, 404, { error: "not_found" });
  const result = forum.listThreads({
    board: ctx.query.get("board") || "",
    sort: ctx.query.get("sort") === "hot" ? "hot" : "new",
    cursor: ctx.query.get("cursor") || "",
    limit: clamp(toInt(ctx.query.get("limit"), 20), 1, 50),
    viewerId: ctx.user ? ctx.user.id : null
  });
  sendJson(ctx.req, ctx.res, 200, Object.assign(result, { boards: forum.BOARDS }), { "Cache-Control": "no-store" });
});

// POST /api/forum/threads  { board, title, body }
route("POST", "/api/forum/threads", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  if (!requireWritable(ctx, user)) return;

  const bucket = limit(`thread:${user.id}`, 3, 10 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const title = String(payload.title || "").replace(/\s+/g, " ").trim();
  const body = String(payload.body || "").trim();

  if (title.length < forum.TITLE_MIN || title.length > forum.TITLE_MAX) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "invalid_title",
      message: `标题需要 ${forum.TITLE_MIN}–${forum.TITLE_MAX} 个字`
    });
  }
  if (!body.length || body.length > forum.BODY_MAX) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "invalid_length",
      message: `正文最多 ${forum.BODY_MAX} 个字`
    });
  }

  const mod = classify(title + "\n" + body);
  const created = forum.createThread({ authorId: user.id, board: payload.board, title, body, mod });

  // 直接公开的主题立刻发经验；转人工的等审核通过时再发（见 forum.reviewThread）
  if (created.status === "approved") users.addExp(user.id, users.EXP.thread_created);

  sendJson(ctx.req, ctx.res, 201, created);
});

// POST /api/forum/threads/:id/like
route("POST", "/api/forum/threads/:id/like", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const bucket = limit(`thread-like:${user.id}`, 200, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const row = forum.getThreadRow(ctx.params.id);
  if (!row || row.status !== "approved") throw httpError(404, "thread not found");

  const result = forum.toggleLike(row.id, user.id);
  if (result.liked && row.author_id !== user.id) users.addExp(row.author_id, users.EXP.like_received);
  sendJson(ctx.req, ctx.res, 200, result);
});

// GET /api/forum/threads/:id —— 主题 + 回复
route("GET", "/api/forum/threads/:id", (ctx) => {
  if (!config.FEATURES.forum) return sendJson(ctx.req, ctx.res, 404, { error: "not_found" });
  const data = forum.getThread(ctx.params.id, ctx.user ? ctx.user.id : null);
  if (!data) throw httpError(404, "thread not found");
  sendJson(ctx.req, ctx.res, 200, data, { "Cache-Control": "no-store" });
});

// POST /api/forum/threads/:id/replies  { body }
route("POST", "/api/forum/threads/:id/replies", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  if (!requireWritable(ctx, user)) return;

  const bucket = limit(`reply:${user.id}`, 20, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const threadRow = forum.getThreadRow(ctx.params.id);
  if (!threadRow || threadRow.status !== "approved") throw httpError(404, "thread not found");

  const payload = await readJson(ctx.req);
  const body = String(payload.body || "").trim();
  if (!body.length || body.length > forum.REPLY_MAX) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "invalid_length",
      message: `回复最多 ${forum.REPLY_MAX} 个字`
    });
  }

  const mod = classify(body);
  const created = forum.createReply({ threadId: threadRow.id, authorId: user.id, body, mod });
  if (created.status === "approved") users.addExp(user.id, users.EXP.reply_created);

  sendJson(ctx.req, ctx.res, 201, created);
});

/* ───────────────────────── 好友 ───────────────────────── */

// GET /api/friends —— 好友 + 收到/发出的请求
route("GET", "/api/friends", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  sendJson(ctx.req, ctx.res, 200, social.listFriends(user.id), { "Cache-Control": "no-store" });
});

// POST /api/friends/requests  { uuid, message? }
route("POST", "/api/friends/requests", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const bucket = limit(`friend-req:${user.id}`, 20, 60 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const result = social.sendRequest(user.id, payload.uuid, payload.message);
  if (!result.ok) {
    const messages = {
      not_found: "用户不存在",
      self: "不能加自己为好友",
      already_friends: "你们已经是好友",
      blocked: "无法向该用户发送请求"
    };
    const status = result.error === "blocked" ? 403 : 400;
    return sendJson(ctx.req, ctx.res, status, { error: result.error, message: messages[result.error] || "操作失败" });
  }
  sendJson(ctx.req, ctx.res, 201, result);
});

// POST /api/friends/requests/:uuid/accept | /decline
route("POST", "/api/friends/requests/:uuid/:action", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const action = ctx.params.action;
  if (action !== "accept" && action !== "decline") throw httpError(404, "not found");

  const result = action === "accept"
    ? social.acceptRequest(user.id, ctx.params.uuid)
    : social.declineRequest(user.id, ctx.params.uuid);

  if (!result.ok) {
    return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: "请求不存在或已处理" });
  }
  sendJson(ctx.req, ctx.res, 200, { ok: true });
});

// DELETE /api/friends/:uuid —— 删除好友
route("DELETE", "/api/friends/:uuid", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  const result = social.removeFriend(user.id, ctx.params.uuid);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: "操作失败" });
  sendJson(ctx.req, ctx.res, 200, { ok: true });
});

/* ───────────────────────── 私信 ───────────────────────── */

// GET /api/dm/conversations —— 会话列表（必须在 /api/dm/:uuid 之前注册）
route("GET", "/api/dm/conversations", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  sendJson(ctx.req, ctx.res, 200, social.conversations(user.id), { "Cache-Control": "no-store" });
});

// GET /api/dm/unread —— 未读数（底部 tab 的红点）
route("GET", "/api/dm/unread", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  sendJson(ctx.req, ctx.res, 200, { count: social.unreadCount(user.id) }, { "Cache-Control": "no-store" });
});

// GET /api/dm/:uuid?cursor=&limit= —— 与某人的聊天记录（打开即标记已读）
route("GET", "/api/dm/:uuid", (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;

  const result = social.threadWith(user.id, ctx.params.uuid, {
    cursor: ctx.query.get("cursor") || "",
    limit: clamp(toInt(ctx.query.get("limit"), 30), 1, 100)
  });
  if (!result.ok) return sendJson(ctx.req, ctx.res, 404, { error: result.error, message: "用户不存在" });
  sendJson(ctx.req, ctx.res, 200, result, { "Cache-Control": "no-store" });
});

// POST /api/dm/:uuid  { body }
route("POST", "/api/dm/:uuid", async (ctx) => {
  const user = requireLogin(ctx);
  if (!user) return;
  if (!requireWritable(ctx, user)) return;

  const bucket = limit(`dm:${user.id}`, 60, 5 * 60 * 1000);
  if (!bucket.ok) {
    return sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: bucket.retryAfter });
  }

  const payload = await readJson(ctx.req);
  const result = social.sendMessage(user.id, ctx.params.uuid, payload.body);
  if (!result.ok) {
    const messages = {
      not_found: "用户不存在",
      self: "不能给自己发私信",
      not_friends: "只有好友之间才能私信",
      blocked: "无法向该用户发送私信",
      empty: "内容不能为空",
      too_long: `单条私信最多 ${social.DM_MAX} 个字`
    };
    const status = result.error === "blocked" ? 403 : result.error === "not_friends" ? 403 : 400;
    return sendJson(ctx.req, ctx.res, status, { error: result.error, message: messages[result.error] || "发送失败" });
  }
  sendJson(ctx.req, ctx.res, 201, { id: result.id, createdAt: result.createdAt });
});

/* ───────────────────────── 管理接口（需鉴权） ───────────────────────── */

function requireAdmin(ctx) {
  /**
   * 两个独立的限流桶，别把「已登录的正常使用」当成爆破来掐。
   *
   * 老实现只有一个桶（默认 15 分钟 10 次）且对**所有**管理请求计数，结果是后台
   * 自己把自己挡住：控制台一进页面就打 6 个接口（stats + 帖子队列 + 评论队列 +
   * 工单 + 审核日志 + 反馈），点几下审核还要各刷新一遍，十几秒就能撞上限流，
   * 页面开始报 rate_limited。
   *
   *   admin-auth —— 只统计**鉴权失败**的请求，防令牌爆破（默认 15 分钟 10 次，
   *                 可用 ADMIN_RATE_LIMIT 调）
   *   admin-api  —— 已鉴权的请求，上限宽松得多，只为防止脚本把单核数据库刷爆
   *                 （默认 5 分钟 600 次，可用 ADMIN_API_RATE_LIMIT 调）
   */
  if (!isAdmin(ctx.req)) {
    const authBucket = limit(`admin-auth:${ctx.ipHash}`, ADMIN_RATE_LIMIT, 15 * 60 * 1000);
    if (!authBucket.ok) {
      sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: authBucket.retryAfter });
      return false;
    }
    sendJson(ctx.req, ctx.res, 401, { error: "unauthorized" });
    return false;
  }

  const apiBucket = limit(`admin-api:${ctx.ipHash}`, ADMIN_API_RATE_LIMIT, 5 * 60 * 1000);
  if (!apiBucket.ok) {
    sendJson(ctx.req, ctx.res, 429, { error: "rate_limited", retryAfter: apiBucket.retryAfter });
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
  const pendingThreads = one("SELECT COUNT(*) AS n FROM forum_threads WHERE status='pending'");
  const pendingReplies = one("SELECT COUNT(*) AS n FROM forum_replies WHERE status='pending'");
  const openReports = one("SELECT COUNT(*) AS n FROM reports WHERE status='open'");

  // 队列最久等待时长：审核员最需要的一个信号。
  // 两条查询都走既有索引（(status, created_at, id)），且 LIMIT 1 直接取索引头部。
  const oldestPost = db.prepare(
    "SELECT created_at FROM posts WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get();
  const oldestComment = db.prepare(
    "SELECT created_at FROM comments WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get();
  const oldestThread = db.prepare(
    "SELECT created_at FROM forum_threads WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).get();
  const candidates = [
    oldestPost && oldestPost.created_at,
    oldestComment && oldestComment.created_at,
    oldestThread && oldestThread.created_at
  ].filter((v) => Number.isFinite(v) && v > 0);
  const oldestPendingAt = candidates.length ? Math.min(...candidates) : null;

  sendJson(ctx.req, ctx.res, 200, {
    pendingPosts,
    pendingComments,
    pendingThreads,
    pendingReplies,
    openReports,
    approvedPosts: one("SELECT COUNT(*) AS n FROM posts WHERE status='approved'"),
    pendingTotal: pendingPosts + pendingComments + pendingThreads + pendingReplies + openReports,
    oldestPendingAt,
    generatedAt: Date.now(),
    // 运营指标：账号规模、讨论活跃度、待处理反馈
    openFeedback: one("SELECT COUNT(*) AS n FROM feedback WHERE status='open'"),
    users: one("SELECT COUNT(*) AS n FROM users"),
    usersToday: one("SELECT COUNT(*) AS n FROM users WHERE created_at > " + (Date.now() - 86400000)),
    activeToday: one("SELECT COUNT(*) AS n FROM users WHERE last_seen_at > " + (Date.now() - 86400000)),
    threads: one("SELECT COUNT(*) AS n FROM forum_threads WHERE status='approved'"),
    replies: one("SELECT COUNT(*) AS n FROM forum_replies WHERE status='approved'"),
    dmsToday: one("SELECT COUNT(*) AS n FROM dm_messages WHERE created_at > " + (Date.now() - 86400000)),
    version: config.VERSION,
    // 邮件通道：验证码是唯一的登录入口，配置状态必须在后台一眼可见
    email: {
      configured: config.EMAIL.configured,
      from: config.EMAIL.from || "",
      fromName: config.EMAIL.fromName || "",
      ttlSeconds: config.CODE_TTL
    },
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
  const rawType = String(ctx.query.get("type") || "posts");
  const type = ["comments", "threads", "replies"].includes(rawType) ? rawType : "posts";
  const take = clamp(toInt(ctx.query.get("limit"), 50), 1, 100);
  const q = String(ctx.query.get("q") || "").trim().slice(0, 60);
  const cursor = parseQueueCursor(ctx.query.get("cursor"));

  // 论坛队列复用同一个入口：审核员只需要记一个地址、一套游标规则。
  // 论坛的队列按 id 正序（先来先审），游标语义与帖子/评论的时间游标不同，
  // 因此这里单独走 id 游标，而不是硬套 created_at.id。
  if (type === "threads" || type === "replies") {
    const idCursor = toInt(ctx.query.get("cursor"), 0);
    const data = type === "threads"
      ? forum.queueThreads({ limit: take, cursor: idCursor })
      : forum.queueReplies({ limit: take, cursor: idCursor });
    return sendJson(ctx.req, ctx.res, 200, Object.assign({ type }, data));
  }

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

/* ───────────────────────── 用户管理 ─────────────────────────
 * 「后台可以看到用户全部信息」是本次的硬要求，因此这里的字段是完整的：
 * 邮箱、uuid、昵称（含预审标记）、学校、简介、头衔、等级、经验、状态、
 * 注册/登录时间、IP 与 UA 哈希（不可逆）、以及各项内容计数。
 * 明文密码不存在（本站没有密码），明文 IP 也不存在（只存哈希）。
 * ---------------------------------------------------------- */

// GET /api/admin/users?q=&status=&cursor=&limit=
route("GET", "/api/admin/users", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const result = users.listUsers({
    q: String(ctx.query.get("q") || "").trim().slice(0, 40),
    status: String(ctx.query.get("status") || "").trim(),
    cursor: toInt(ctx.query.get("cursor"), 0),
    limit: clamp(toInt(ctx.query.get("limit"), 30), 1, 100)
  });
  sendJson(ctx.req, ctx.res, 200, result);
});

// GET /api/admin/users/:id —— 单人详情 + 最近内容
route("GET", "/api/admin/users/:id", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const row = users.findById(ctx.params.id);
  if (!row) throw httpError(404, "user not found");

  const recent = {
    posts: db.prepare(
      "SELECT id, cat, body, status, created_at FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 10"
    ).all(row.id),
    comments: db.prepare(
      "SELECT id, post_id, body, status, created_at FROM comments WHERE user_id = ? ORDER BY id DESC LIMIT 10"
    ).all(row.id),
    threads: db.prepare(
      "SELECT id, board, title, status, created_at FROM forum_threads WHERE author_id = ? ORDER BY id DESC LIMIT 10"
    ).all(row.id),
    messages: social.recentMessagesFor(row.id, 10).map((m) => ({
      id: m.id,
      direction: m.sender_id === row.id ? "out" : "in",
      body: m.body,
      createdAt: m.created_at
    }))
  };

  sendJson(ctx.req, ctx.res, 200, { user: users.adminUser(row), recent });
});

// POST /api/admin/users/:id  { action, value }
route("POST", "/api/admin/users/:id", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const row = users.findById(ctx.params.id);
  if (!row) throw httpError(404, "user not found");

  const payload = await readJson(ctx.req);
  const action = String(payload.action || "");
  const value = payload.value;

  let result;
  switch (action) {
    case "set_title":
      result = users.setUserTitle(row.id, value);
      break;
    case "set_level":
      result = users.setUserLevel(row.id, value);
      break;
    case "set_exp":
      result = users.setUserExp(row.id, value);
      break;
    case "set_status":
      result = users.setUserStatus(row.id, value);
      break;
    case "rename":
      result = users.renameUser(row.id, value);
      break;
    case "clear_nickname_flag":
      result = users.clearNicknameFlag(row.id);
      break;
    case "reset_exp":
      result = users.setUserExp(row.id, 0);
      break;
    default:
      return sendJson(ctx.req, ctx.res, 400, { error: "unknown_action" });
  }

  if (!result.ok) {
    return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: "操作未被接受" });
  }

  // 封禁等敏感动作留痕：谁、对谁、做了什么
  audit("user." + action, row.uuid, JSON.stringify(value == null ? null : value).slice(0, 80), ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, user: users.adminUser(users.findById(row.id)) });
});

/* ───────────────────────── 头衔管理 ───────────────────────── */

// GET /api/admin/titles
route("GET", "/api/admin/titles", (ctx) => {
  if (!requireAdmin(ctx)) return;
  sendJson(ctx.req, ctx.res, 200, { items: users.listTitles() });
});

// POST /api/admin/titles  { name, color?, minLevel?, auto?, sort? }
route("POST", "/api/admin/titles", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = users.createTitle(payload);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error });
  audit("title.create", String(result.id), String(payload.name || ""), ctx.ip);
  sendJson(ctx.req, ctx.res, 201, { id: result.id, items: users.listTitles() });
});

// POST /api/admin/titles/:id  { name?, color?, minLevel?, auto?, sort? }
route("POST", "/api/admin/titles/:id", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = users.updateTitle(ctx.params.id, payload);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error });
  audit("title.update", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: users.listTitles() });
});

// POST /api/admin/titles/:id/delete
route("POST", "/api/admin/titles/:id/delete", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const result = users.deleteTitle(ctx.params.id);
  if (!result.ok) throw httpError(404, "title not found");
  audit("title.delete", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: users.listTitles() });
});

/* ───────────────────────── 学校管理 ─────────────────────────
 * 学校名单由后台维护：这是本校本地的运营数据，代码与配置文件都不该写死。
 * 删除学校**不影响**已经选了它的用户（users.school 存的是校名快照）。
 * ---------------------------------------------------------- */

// GET /api/admin/schools
route("GET", "/api/admin/schools", (ctx) => {
  if (!requireAdmin(ctx)) return;
  sendJson(ctx.req, ctx.res, 200, { items: users.listSchoolsAdmin() });
});

// POST /api/admin/schools  { name, sort? }
route("POST", "/api/admin/schools", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = users.createSchool(payload);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error });
  audit("school.create", String(result.id), String(payload.name || ""), ctx.ip);
  sendJson(ctx.req, ctx.res, 201, { id: result.id, items: users.listSchoolsAdmin() });
});

// POST /api/admin/schools/:id  { name?, sort?, active? }
route("POST", "/api/admin/schools/:id", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = users.updateSchool(ctx.params.id, payload);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error });
  audit("school.update", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: users.listSchoolsAdmin() });
});

// POST /api/admin/schools/:id/delete
route("POST", "/api/admin/schools/:id/delete", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const result = users.deleteSchool(ctx.params.id);
  if (!result.ok) throw httpError(404, "school not found");
  audit("school.delete", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: users.listSchoolsAdmin() });
});

/* ───────────────────────── 公告管理 ───────────────────────── */

// GET /api/admin/announcements
route("GET", "/api/admin/announcements", (ctx) => {
  if (!requireAdmin(ctx)) return;
  sendJson(ctx.req, ctx.res, 200, { items: announce.listAll() });
});

// POST /api/admin/announcements  { body, link?, linkText?, sort?, active? }
route("POST", "/api/admin/announcements", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = announce.create(payload);
  if (!result.ok) {
    const messages = { empty: "公告内容不能为空", too_long: `公告最多 ${announce.BODY_MAX} 个字` };
    return sendJson(ctx.req, ctx.res, 400, { error: result.error, message: messages[result.error] });
  }
  audit("announce.create", String(result.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 201, { id: result.id, items: announce.listAll() });
});

// POST /api/admin/announcements/:id  —— 更新 / 启停
route("POST", "/api/admin/announcements/:id", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = announce.update(ctx.params.id, payload);
  if (!result.ok) return sendJson(ctx.req, ctx.res, 400, { error: result.error });
  audit("announce.update", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: announce.listAll() });
});

// POST /api/admin/announcements/:id/delete
route("POST", "/api/admin/announcements/:id/delete", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const result = announce.remove(ctx.params.id);
  if (!result.ok) throw httpError(404, "announcement not found");
  audit("announce.delete", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, items: announce.listAll() });
});

/* ─────────────────────── 论坛审核动作 ─────────────────────── */

// POST /api/admin/threads/:id/(approve|reject|remove)
route("POST", "/api/admin/threads/:id/:action", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const action = ctx.params.action;
  if (!["approve", "reject", "remove"].includes(action)) throw httpError(404, "not found");
  const result = forum.reviewThread(ctx.params.id, action);
  if (!result.ok) throw httpError(404, "thread not found");
  audit("thread." + action, String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, result);
});

// POST /api/admin/replies/:id/(approve|reject|remove)
route("POST", "/api/admin/replies/:id/:action", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const action = ctx.params.action;
  if (!["approve", "reject", "remove"].includes(action)) throw httpError(404, "not found");
  const result = forum.reviewReply(ctx.params.id, action);
  if (!result.ok) throw httpError(404, "reply not found");
  audit("reply." + action, String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, result);
});

/**
 * 邮件通道自检：给指定地址发一封测试邮件。
 *
 * 为什么值得单独做一个接口：验证码是唯一的登录入口，配置错了**用户根本进不来**，
 * 而错误往往只出现在服务端日志里（面板上看不到）。这里把 Cloudflare 的原始错误
 * 原样回给后台，运维点一下就知道是哪一步没配好。
 */
route("POST", "/api/admin/email/test", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const payload = await readJson(ctx.req);
  const to = users.normalizeEmail(payload.to);
  if (!users.isValidEmail(to)) {
    return sendJson(ctx.req, ctx.res, 400, { error: "invalid_email", message: "收件地址不合法" });
  }

  const mail = email.codeMail({
    code: "123456",
    siteName: config.SITE_NAME,
    ttlMinutes: Math.round(config.CODE_TTL / 60),
    purpose: "login"
  });
  const result = await email.sendMail({
    to,
    subject: "[自检] " + mail.subject,
    html: mail.html,
    text: "这是一封配置自检邮件。\n\n" + mail.text
  });

  audit("email.test", to, result.ok ? "ok" : (result.error || "failed"), ctx.ip);
  sendJson(ctx.req, ctx.res, 200, {
    ok: Boolean(result.ok),
    degraded: Boolean(result.degraded),
    delivered: result.delivered || [],
    queued: result.queued || [],
    error: result.error || "",
    configured: config.EMAIL.configured,
    from: config.EMAIL.from || ""
  });
});

/* ───────────────────────── 赞助（爱发电）管理 ───────────────────────── */

// GET /api/admin/afdian?filter=all|unbound|bound&limit=&cursor=
route("GET", "/api/admin/afdian", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const rawFilter = String(ctx.query.get("filter") || "");
  const filter = ["all", "unbound", "bound"].includes(rawFilter) ? rawFilter : "all";
  const result = afdian.listOrders({
    filter,
    limit: clamp(toInt(ctx.query.get("limit"), 30), 1, 100),
    cursor: toInt(ctx.query.get("cursor"), 0)
  });
  sendJson(ctx.req, ctx.res, 200, Object.assign(result, {
    filter,
    stats: afdian.stats(),
    recentWebhooks: afdian.recentWebhooks()
  }));
});

// POST /api/admin/afdian/orders/:id/bind  { uuid } —— 手动把一单算到某个用户头上
route("POST", "/api/admin/afdian/orders/:id/bind", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const payload = await readJson(ctx.req);
  const result = afdian.bindOrder(ctx.params.id, String(payload.uuid || "").trim());
  if (!result.ok) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: result.error,
      message: result.error === "user_not_found" ? "没有这个用户（uuid 不对？）" : "订单不存在"
    });
  }
  audit("afdian.bind", ctx.params.id, result.reward || "", ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true, reward: result.reward, user: result.user });
});

// POST /api/admin/afdian/orders/:id/ignore —— 忽略一单（测试单、自己给自己下单…）
route("POST", "/api/admin/afdian/orders/:id/ignore", (ctx) => {
  if (!requireAdmin(ctx)) return;
  const result = afdian.ignoreOrder(ctx.params.id);
  if (!result.ok) throw httpError(404, "order not found");
  audit("afdian.ignore", String(ctx.params.id), null, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, { ok: true });
});

// POST /api/admin/afdian/sync  { pages? } —— 回调漏了时手动补单（按 out_trade_no 去重）
route("POST", "/api/admin/afdian/sync", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  if (!config.AFDIAN.apiReady) {
    return sendJson(ctx.req, ctx.res, 400, {
      error: "afdian_not_configured",
      message: "需要先配置 AFDIAN_USER_ID 与 AFDIAN_TOKEN"
    });
  }
  const payload = await readJson(ctx.req);
  const result = await afdian.syncOrders(clamp(toInt(payload.pages, 3), 1, 20));
  audit("afdian.sync", null, `导入 ${result.imported} 单`, ctx.ip);
  sendJson(ctx.req, ctx.res, 200, result);
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
      // 会话只在 API 请求上解析：静态产物每个请求都查一次库毫无意义。
      // 解析失败（过期/被删/被封禁）一律按未登录处理，不抛错。
      ctx.token = users.tokenFromCookie(req.headers.cookie);
      ctx.user = ctx.token ? users.userForToken(ctx.token) : null;

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
/**
 * 会话与验证码清理：过期的会话行会一直留着（表不大，但没必要）。
 * 6 小时一次，unref 不影响退出。刻意不做「每次请求顺手删」——
 * 那是把清理成本摊到热路径上，低配机器上不划算。
 */
const sessionSweeper = setInterval(() => {
  try {
    const sessions = users.pruneSessions();
    const codes = db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(Date.now() - 86400000);
    const tokens = db.prepare("DELETE FROM register_tokens WHERE expires_at < ?").run(Date.now() - 86400000);
    const total = sessions + codes.changes + tokens.changes;
    if (total) console.log(`[auth] 清理过期凭据 ${total} 条`);
  } catch (err) {
    console.warn("[auth] 清理失败：" + err.message);
  }
}, 6 * 60 * 60 * 1000);
sessionSweeper.unref();

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  console.log(`[up] ${config.SITE_NAME} v${config.VERSION} http://${HOST}:${PORT}`
    + `（端口来自 ${PORT_SOURCE}）`);
  if (ENV_LOADED) console.log(`[env] 已从 ${ENV_FILE} 读取 ${ENV_LOADED} 项配置`);
  console.log(`[up] 静态根目录 ${WEB_ROOT}`);
  console.log(`[up] 数据库 ${db.DB_PATH}（页缓存 ${db.CACHE_MB}MB）`);
  console.log(`[up] 邮件通道 ${config.EMAIL.configured
    ? "Cloudflare Email Service 已配置"
    : "未配置（验证码写入 server/data/outbox/）"}`);
  console.log(`[up] 学校名单 ${users.schoolList().length} 所`
    + `｜论坛 ${config.FEATURES.forum ? "开启" : "关闭"}`
    + `｜私信 ${config.FEATURES.dm ? "开启" : "关闭"}`);

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
 * 唯一可能悬挂的是发信请求，而它自带 AbortController 超时（CF_EMAIL_TIMEOUT_MS）。
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
