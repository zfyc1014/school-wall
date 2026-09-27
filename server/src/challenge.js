"use strict";

/**
 * Cloudflare Turnstile 人机验证（服务端校验）。
 *
 * 为什么选 Turnstile：免费、无用户跟踪、对国内访客可达，且对低配 VPS 极友好 ——
 * 校验是一次出网的 HTTPS POST（只有「首次验证」才发生），通过后本服务签发一个
 * 短期会话 cookie，后续请求不再往返 Cloudflare。
 *
 * 三层设计：
 *
 *   1. **入口闸门**：前端拿到 sitekey 后在首屏渲染托管式 widget；
 *      校验通过 → POST /api/challenge/session → 本服务签发 HMAC 会话 cookie。
 *   2. **写操作闸门**（服务端强制，不依赖前端）：发帖 / 评论 / 举报 / 点赞
 *      都必须带有效会话 cookie，或直接带一个一次性 token。
 *      「前端隐藏按钮」不算防护，能直接打 API 的脚本才是真正要拦的东西。
 *   3. **防重放**：Turnstile token 单次有效（5 分钟）。同一 IP 校验成功后在
 *      SESSION_TTL 内复用会话，避免每次互动都出网一次。
 *
 * 关键约束（来自 Cloudflare 官方文档）：
 *   - 校验端点 POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   - token 有效期 300 秒、一次性；重放会返回 timeout-or-duplicate
 *   - 必须服务端校验，客户端 widget 本身不构成防护
 *   - 生产 sitekey 会拒绝 dummy token，反之亦然（测试必须成套替换）
 *
 * 配置（全部可选；未配置 TURNSTILE_SECRET 时功能整体关闭）：
 *   TURNSTILE_SITE_KEY   前端 widget 的 sitekey（会下发给浏览器，非机密）
 *   TURNSTILE_SECRET     服务端密钥（机密，只存在于服务端）
 *   TURNSTILE_ACTIONS    允许的 action 白名单（逗号分隔），留空不校验
 *   TURNSTILE_HOSTNAMES  允许的 hostname 白名单（逗号分隔），留空不校验
 *   CHALLENGE_TTL        会话有效期秒数，默认 1800
 *   CHALLENGE_ENFORCE    1 强制 / 0 关闭；默认 = production 时开启
 *   CHALLENGE_FAIL_OPEN  Cloudflare 不可达时是否放行，默认 0（拒绝）
 */

const crypto = require("crypto");
const fs = require("fs");

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_MAX_LEN = 2048; // 官方上限

const IS_PROD = process.env.NODE_ENV === "production";
const SITE_KEY = String(process.env.TURNSTILE_SITE_KEY || "").trim();
const SECRET = String(process.env.TURNSTILE_SECRET || "").trim();
const TTL_SECONDS = Math.max(60, Number(process.env.CHALLENGE_TTL || 1800));
const FAIL_OPEN = process.env.CHALLENGE_FAIL_OPEN === "1";
const COOKIE_NAME = process.env.CHALLENGE_COOKIE || "od_challenge";
const COOKIE_SECURE = process.env.CHALLENGE_COOKIE_SECURE === "1" || IS_PROD;

const ACTIONS = String(process.env.TURNSTILE_ACTIONS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const HOSTNAMES = String(process.env.TURNSTILE_HOSTNAMES || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** 是否具备启用条件：sitekey + secret 都配置了 */
const CONFIGURED = Boolean(SITE_KEY && SECRET);

/** 是否强制校验：显式配置优先，否则生产环境默认开启 */
const ENFORCE = process.env.CHALLENGE_ENFORCE === "1"
  || (process.env.CHALLENGE_ENFORCE !== "0" && IS_PROD && CONFIGURED);

/** 是否启用（配置齐全且强制） */
const ENABLED = CONFIGURED && ENFORCE;

/** 签名密钥：优先独立的 CHALLENGE_SECRET，否则复用 IP_HASH_SECRET */
const SIGN_KEY = process.env.CHALLENGE_SECRET
  || process.env.IP_HASH_SECRET
  || crypto.randomBytes(32).toString("hex");

/** 同一 IP 校验成功后的短期复用缓存；只存哈希，不存原始 IP */
const verifiedIps = new Map(); // ipHash -> expiresAt

/**
 * 致命错误输出必须是**同步**的。
 * console.error 在 Windows 上对管道/文件是异步写，紧接着 process.exit() 会把
 * 还没刷出去的内容丢掉 —— 排查线上启动失败时看不到原因，非常难查。
 */
function fatalStderr(message) {
  const text = message
    .split("\n")
    .map((line, i) => (i === 0 ? `[challenge] ${line}` : `[challenge] ${line}`))
    .join("\n") + "\n";
  try {
    fs.writeSync(2, text);
  } catch {
    /* 极端情况下 stderr 不可写，忽略 */
  }
}

function logConfig({ fatal } = {}) {
  if (ENABLED) {
    console.log(`[challenge] Turnstile 已启用（会话 ${TTL_SECONDS}s，fail-${FAIL_OPEN ? "open" : "closed"}）`);
    if (!ACTIONS.length && !HOSTNAMES.length) {
      console.warn("[challenge] 未配置 TURNSTILE_ACTIONS / TURNSTILE_HOSTNAMES 白名单，建议至少配置 hostname");
    }
    return;
  }
  if (CONFIGURED && !ENFORCE) {
    console.warn("[challenge] 已配置密钥但 CHALLENGE_ENFORCE=0，人机验证当前关闭");
    return;
  }
  if (!CONFIGURED) {
    const message = [
      "未配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET，人机验证关闭 ——",
      "  生产环境默认拒绝以此状态启动（裸奔的写接口会被脚本刷穿）。",
      "  修复：在环境变量中配置 Turnstile 密钥；",
      "        或显式设置 CHALLENGE_ALLOW_DISABLED=1 明确承担风险。",
    ].join("\n");
    if (IS_PROD && process.env.CHALLENGE_ALLOW_DISABLED !== "1") {
      // 由调用方决定退出方式：它才知道怎么干净收尾（关库、刷日志）。
      if (typeof fatal === "function") return fatal(message);
      fatalStderr(message);
      process.exit(1);
    }
    console.warn("[challenge] 未配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET，人机验证关闭");
  }
}

/* ───────────────────────────── cookie ───────────────────────────── */

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function sign(ipHash, exp) {
  return crypto.createHmac("sha256", SIGN_KEY).update(`${ipHash}.${exp}`).digest("base64url");
}

/** 会话值绑定 IP 哈希：cookie 被复制到别的网络环境即失效 */
function issueCookie(ipHash) {
  const exp = Date.now() + TTL_SECONDS * 1000;
  const value = `${exp}.${sign(ipHash, exp)}`;
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TTL_SECONDS}`
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie() {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

function readSession(req, ipHash) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const exp = Number(raw.slice(0, dot));
  const mac = raw.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;

  const expect = sign(ipHash, exp);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { exp, expiresAt: exp };
}

/* ────────────────────────── Cloudflare 校验 ────────────────────────── */

let lastError = "";

/**
 * 调用 siteverify。任何网络/解析异常都转成失败结果，
 * 不把异常抛给业务层 —— 校验失败与否由 fail-open/closed 策略决定。
 */
async function siteverify(token, remoteIp) {
  const body = { secret: SECRET, response: token };
  if (remoteIp) body.remoteip = remoteIp;
  // 官方建议：为可安全重试的请求带上幂等键
  body.idempotency_key = crypto.randomUUID();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "siteverify 超时" : `siteverify 不可达：${err.message}`;
    return { ok: false, data: { success: false, "error-codes": ["internal-error"], reason } };
  } finally {
    clearTimeout(timer);
  }
}

/** 校验 Turnstile 返回的 hostname / action 是否在白名单内 */
function policyViolation(data) {
  if (HOSTNAMES.length && data.hostname && !HOSTNAMES.includes(String(data.hostname).toLowerCase())) {
    return `hostname 不在白名单：${data.hostname}`;
  }
  if (ACTIONS.length && data.action && !ACTIONS.includes(String(data.action))) {
    return `action 不在白名单：${data.action}`;
  }
  return "";
}

/**
 * 取客户端真实 IP：Cloudflare 会在 CF-Connecting-IP 里给出原始访客 IP，
 * 这是回传给 siteverify 最准确的值（反代链路上的 XFF 可能被伪造）。
 */
function visitorIp(req, fallback) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  return fallback;
}

/* ───────────────────────────── 对外接口 ───────────────────────────── */

/** 下发给前端的公开配置（不含任何机密） */
function publicConfig() {
  return {
    enabled: ENABLED,
    required: ENABLED,
    siteKey: ENABLED ? SITE_KEY : "",
    sessionTtl: TTL_SECONDS,
    error: lastError
  };
}

/** 当前请求是否已通过验证（仅读 cookie，无副作用） */
function hasSession(req, ipHash) {
  if (!ENABLED) return true;
  if (readSession(req, ipHash)) return true;
  const exp = verifiedIps.get(ipHash);
  if (exp && exp > Date.now()) return true;
  if (exp) verifiedIps.delete(ipHash);
  return false;
}

function cacheVerified(ipHash) {
  verifiedIps.set(ipHash, Date.now() + TTL_SECONDS * 1000);
  // 顺手清理过期项，避免 Map 随 IP 数无限增长
  if (verifiedIps.size > 5000) {
    const now = Date.now();
    for (const [key, exp] of verifiedIps) {
      if (exp <= now) verifiedIps.delete(key);
    }
  }
}

/**
 * 校验一个 token 并（可选）签发会话。
 * @returns {Promise<{success: boolean, code?: string, message?: string, cookie?: string, hostname?: string}>}
 */
async function verifyToken(req, { token, ip, ipHash }) {
  if (!ENABLED) return { success: true, code: "disabled" };

  if (!token) return { success: false, code: "missing_token", message: "缺少人机验证凭据" };
  if (typeof token !== "string" || token.length > TOKEN_MAX_LEN) {
    return { success: false, code: "invalid_token", message: "人机验证凭据格式不正确" };
  }

  const result = await siteverify(token, visitorIp(req, ip));
  const data = result.data || {};

  if (!result.ok) {
    lastError = data.reason || "siteverify 调用失败";
    console.warn("[challenge]", lastError);
    return FAIL_OPEN
      ? { success: true, code: "fail_open", message: "验证服务不可达，已按策略放行" }
      : { success: false, code: "verify_unavailable", message: "验证服务暂时不可用，请稍后重试" };
  }

  if (!data.success) {
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"] : [];
    // 令牌过期或已用过：单独给码，前端据此重置 widget 让用户重试
    const expired = codes.includes("timeout-or-duplicate");
    return {
      success: false,
      code: expired ? "token_expired" : "verify_failed",
      message: expired ? "验证已过期，请重新验证" : "人机验证未通过",
      codes
    };
  }

  const violation = policyViolation(data);
  if (violation) {
    console.warn("[challenge] 策略拒绝：", violation);
    return { success: false, code: "policy_rejected", message: "验证来源不被允许" };
  }

  lastError = "";
  cacheVerified(ipHash);
  return { success: true, code: "ok", cookie: issueCookie(ipHash), hostname: data.hostname };
}

/**
 * 写操作闸门：前端在 header 里带一次性 token，或已持有会话 cookie。
 * 这是**服务端**的强制检查，前端按钮的禁用只是 UX。
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string, message: string}>}
 */
async function guardWrite(req, ctx) {
  if (!ENABLED) return { ok: true };

  if (hasSession(req, ctx.ipHash)) return { ok: true };

  const token = req.headers["cf-turnstile-response"] || req.headers["x-turnstile-token"];
  if (!token) {
    return {
      ok: false,
      status: 403,
      error: "challenge_required",
      message: "请先完成人机验证"
    };
  }

  const result = await verifyToken(req, {
    token: String(token),
    ip: ctx.ip,
    ipHash: ctx.ipHash
  });

  if (result.success) return { ok: true };

  return {
    ok: false,
    status: result.code === "verify_unavailable" ? 503 : 403,
    error: result.code,
    message: result.message || "人机验证未通过"
  };
}

module.exports = {
  logConfig,
  publicConfig,
  hasSession,
  verifyToken,
  guardWrite,
  issueCookie,
  clearCookie,
  COOKIE_NAME,
  ENABLED,
  CONFIGURED,
  ENFORCE,
  TTL_SECONDS,
  SITEVERIFY_URL
};
