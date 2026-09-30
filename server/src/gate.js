"use strict";

/**
 * 内测门禁（自托管）。
 *
 * 取代原先的 Cloudflare Turnstile：**不依赖任何第三方、不出网、可离线部署**。
 * 整个校验链路都在本进程内完成，因此没有「验证服务不可达」这种失败模式，
 * 也不需要 CSP 为外部脚本开洞、不需要向第三方回传访客 IP。
 *
 * 三层：
 *
 *   1. **内测邀请码**（人手一份的共享口令）：把站点关在小范围内。
 *      服务端只保存邀请码的 HMAC-SHA256，比较用 timingSafeEqual，长度不等直接失败。
 *   2. **一次性本地挑战**：服务端出题（两位数加减），答案只存在服务端内存里，
 *      客户端提交答案换会话。挑战 10 分钟过期、一次性、最多错 5 次。
 *      它拦不住针对性写脚本的人，但能拦掉「随手写的批量刷屏」——
 *      对低配机器来说，真正的防线是限流 + 先审后发（没有人工审核任何内容都不会公开）。
 *   3. **短期会话 cookie**：HMAC 签名、绑定 IP 哈希、HttpOnly。
 *      会话有效期内写操作不再重复答题（内测体验优先，默认 12 小时）。
 *
 * 为什么不用 JWT/第三方库：这里只需要「过期时间 + HMAC」，Node 内置 crypto 足够，
 * 少一个依赖就少一份供应链面；cookie 里也没有任何可读的个人信息。
 *
 * 配置（全部可选；生产环境必须配置邀请码，否则拒绝启动）：
 *   GATE_ENFORCE        1 强制 / 0 关闭；默认 = 生产且已配置邀请码时开启
 *   GATE_INVITE_CODES   邀请码，逗号分隔（每个至少 8 位）
 *   GATE_TTL            会话有效期秒数，默认 43200（12 小时）
 *   GATE_CHALLENGE_TTL  挑战有效期秒数，默认 600（10 分钟）
 *   GATE_CHALLENGE_ITEMS 挑战题目数，默认 2（1–4）
 *   GATE_MAX_ATTEMPTS   单次挑战最大答错次数，默认 5
 *   GATE_COOKIE         cookie 名，默认 od_gate
 *   GATE_COOKIE_SECURE  1 = 仅 HTTPS；生产默认 1
 *   GATE_SECRET         会话签名密钥，默认复用 IP_HASH_SECRET
 *   GATE_ALLOW_DISABLED 生产环境未配置邀请码时的逃生开关（明确承担风险）
 */

const crypto = require("crypto");
const fs = require("fs");

const IS_PROD = process.env.NODE_ENV === "production";

const TTL_SECONDS = clamp(Number(process.env.GATE_TTL || 43200), 60, 30 * 86400);
const CHALLENGE_TTL_SECONDS = clamp(Number(process.env.GATE_CHALLENGE_TTL || 600), 30, 3600);
const CHALLENGE_TTL_MS = CHALLENGE_TTL_SECONDS * 1000;
const CHALLENGE_ITEMS = clamp(Number(process.env.GATE_CHALLENGE_ITEMS || 2), 1, 4);
const MAX_ATTEMPTS = clamp(Number(process.env.GATE_MAX_ATTEMPTS || 5), 1, 20);
const COOKIE_NAME = process.env.GATE_COOKIE || "od_gate";
/**
 * 会话 cookie 的 Secure 属性：显式配置优先，否则生产默认开启。
 *
 * `GATE_COOKIE_SECURE=0` 必须能在生产下生效（而不是被 IS_PROD 一票否决）：
 * 内测很可能部署在学校内网的纯 HTTP 地址上，浏览器会直接丢弃带 Secure 的
 * cookie —— 用户表现为「验证通过后又立刻要求验证」的死循环，而且只有在
 * 非 localhost 的 HTTP 环境下才暴露（localhost 被浏览器视为可信来源，
 * 所以本机验收永远看起来是好的）。这是一个显式逃生开关，设置时会打警告。
 */
const COOKIE_SECURE = process.env.GATE_COOKIE_SECURE === "1"
  || (process.env.GATE_COOKIE_SECURE !== "0" && IS_PROD);
if (IS_PROD && process.env.GATE_COOKIE_SECURE === "0") {
  console.warn("[gate] GATE_COOKIE_SECURE=0：生产环境下会话 cookie 不带 Secure，"
    + "仅应在无法启用 HTTPS 的内网部署中使用（cookie 可能被中间人窃取）");
}
/** 待答挑战的条目上限：正常流量下远达不到，超过即按最旧淘汰，内存占用恒定 */
const PENDING_MAX = 4096;

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* ─────────────────────────── 邀请码 ─────────────────────────── */

const MIN_CODE_LEN = 8;

/** 邀请码只以 HMAC 形式留在内存里；比较时也不做字符串比较 */
const SIGN_KEY = process.env.GATE_SECRET
  || process.env.IP_HASH_SECRET
  || crypto.randomBytes(32).toString("hex");

function fingerprint(value) {
  return crypto.createHmac("sha256", SIGN_KEY).update(`code:${value}`).digest();
}

const INVITE_HASHES = String(process.env.GATE_INVITE_CODES || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((code) => {
    if (code.length >= MIN_CODE_LEN) return true;
    console.warn(`[gate] 忽略过短的邀请码（至少 ${MIN_CODE_LEN} 位）：${code.slice(0, 2)}…`);
    return false;
  })
  .map(fingerprint);

const INVITE_REQUIRED = INVITE_HASHES.length > 0;

/** 是否强制走门禁：显式配置优先，否则生产环境默认开启 */
const ENFORCE = process.env.GATE_ENFORCE === "1"
  || (process.env.GATE_ENFORCE !== "0" && IS_PROD && INVITE_REQUIRED);

/** 是否启用（强制即为启用；未配邀请码时退化为「只答题」模式） */
const ENABLED = ENFORCE;

function matchInvite(code) {
  if (!INVITE_REQUIRED) return true;
  const value = String(code || "").trim();
  if (!value) return false;
  const candidate = fingerprint(value);
  // 逐个比较且不提前返回：避免用「第几个码匹配」的耗时差异做枚举
  let hit = false;
  for (const known of INVITE_HASHES) {
    if (known.length === candidate.length && crypto.timingSafeEqual(known, candidate)) hit = true;
  }
  return hit;
}

/* ─────────────────────────── 本地挑战 ─────────────────────────── */

/** id -> { answers: string[], expiresAt, attempts, ipHash } */
const pending = new Map();

function prunePending(now) {
  for (const [id, item] of pending) {
    if (item.expiresAt <= now) pending.delete(id);
  }
  // 极端情况下（例如被灌入大量挑战）按插入顺序淘汰最旧的条目
  while (pending.size > PENDING_MAX) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

function rnd(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 生成一道题。题目与答案分开：下发给浏览器的只有题面。
 * 只用两位数加减 —— 人一眼能算出来，机器要真正解析题面才能答对。
 */
function makeItem() {
  const a = rnd(2, 9);
  const b = rnd(11, 99);
  if (Math.random() < 0.5) return { q: `${b} + ${a} = ?`, a: String(b + a) };
  return { q: `${b} - ${a} = ?`, a: String(b - a) };
}

/**
 * 签发一次性挑战。答案留在服务端内存里，随条目过期一起消失。
 * @returns {{id: string, items: {q: string}[], expiresAt: number, ttlSeconds: number}}
 */
function issueChallenge(ipHash) {
  const now = Date.now();
  prunePending(now);

  const answers = [];
  const items = [];
  for (let i = 0; i < CHALLENGE_ITEMS; i += 1) {
    const item = makeItem();
    items.push({ q: item.q });
    answers.push(item.a);
  }

  const id = crypto.randomBytes(18).toString("base64url");
  const expiresAt = now + CHALLENGE_TTL_MS;
  pending.set(id, { answers, expiresAt, attempts: 0, ipHash });

  return { id, items, expiresAt, ttlSeconds: CHALLENGE_TTL_SECONDS };
}

/** 归一化作答：容忍空白与大小写差异，不做任何「智能纠错」 */
function normalizeAnswer(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, "").toLowerCase();
}

function checkChallenge({ id, answers, ipHash }) {
  const item = pending.get(String(id || ""));
  if (!item) return { ok: false, code: "challenge_expired", message: "验证已过期，请重新获取题目" };

  if (item.expiresAt <= Date.now()) {
    pending.delete(String(id));
    return { ok: false, code: "challenge_expired", message: "验证已过期，请重新获取题目" };
  }

  // 挑战与 IP 绑定：把题目搬到另一台机器上批量作答没有意义
  if (item.ipHash && ipHash && item.ipHash !== ipHash) {
    pending.delete(String(id));
    return { ok: false, code: "challenge_expired", message: "网络环境已变化，请重新获取题目" };
  }

  item.attempts += 1;
  if (item.attempts > MAX_ATTEMPTS) {
    pending.delete(String(id));
    return { ok: false, code: "challenge_failed", message: "错误次数过多，请重新获取题目" };
  }

  const given = Array.isArray(answers) ? answers : [];
  const pass = item.answers.every((expect, i) => normalizeAnswer(given[i]) === expect);

  if (!pass) {
    const left = Math.max(0, MAX_ATTEMPTS - item.attempts);
    return {
      ok: false,
      code: "challenge_failed",
      message: left > 0 ? `答案不正确，还可以试 ${left} 次` : "答案不正确，请重新获取题目",
      remaining: left
    };
  }

  pending.delete(String(id)); // 一次性：答对即作废，不给重放留窗口
  return { ok: true };
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
  const attrs = [
    `${COOKIE_NAME}=${exp}.${sign(ipHash, exp)}`,
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

/* ───────────────────────────── 对外接口 ───────────────────────────── */

function publicConfig() {
  return {
    enabled: ENABLED,
    required: ENABLED,
    inviteRequired: INVITE_REQUIRED,
    sessionTtl: TTL_SECONDS,
    challengeTtl: CHALLENGE_TTL_SECONDS,
    challengeItems: CHALLENGE_ITEMS,
    error: ""
  };
}

/** 当前请求是否已通过门禁（只读 cookie，无副作用） */
function hasSession(req, ipHash) {
  if (!ENABLED) return true;
  return Boolean(readSession(req, ipHash));
}

/**
 * 校验「邀请码 + 挑战答案」，成功则签发会话。
 * @returns {{ok: true, cookie?: string, expiresIn: number} | {ok: false, status: number, code: string, message: string, remaining?: number}}
 */
function verify({ inviteCode, challengeId, answers, ipHash }) {
  if (!ENABLED) return { ok: true, expiresIn: 0 };

  if (!matchInvite(inviteCode)) {
    // 刻意不区分「码为空」与「码错误」，避免辅助枚举
    return { ok: false, status: 403, code: "invalid_code", message: "内测邀请码不正确" };
  }

  const result = checkChallenge({ id: challengeId, answers, ipHash });
  if (!result.ok) {
    return {
      ok: false,
      status: result.code === "challenge_expired" ? 409 : 403,
      code: result.code,
      message: result.message,
      remaining: result.remaining
    };
  }

  return { ok: true, cookie: issueCookie(ipHash), expiresIn: TTL_SECONDS };
}

/**
 * 写操作闸门：服务端强制，不依赖前端按钮。
 * @returns {{ok: true} | {ok: false, status: number, error: string, message: string}}
 */
function guardWrite(req, ctx) {
  if (!ENABLED) return { ok: true };
  if (hasSession(req, ctx.ipHash)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: "gate_required",
    message: "请先输入内测邀请码并通过本地验证"
  };
}

/**
 * 启动自检：生产环境未启用门禁时拒绝启动（除非显式声明承担风险）。
 * 与 fatalConfig 的分工：这里只负责说明原因，怎么退出由调用方决定。
 */
function logConfig({ fatal } = {}) {
  if (ENABLED) {
    console.log(`[gate] 内测门禁已启用（会话 ${TTL_SECONDS}s，`
      + `邀请码 ${INVITE_REQUIRED ? INVITE_HASHES.length + " 个" : "未配置（仅本地挑战）"}）`);
    if (!INVITE_REQUIRED) {
      console.warn("[gate] 未配置 GATE_INVITE_CODES：门禁退化为「只答题」，建议配置邀请码把站点关在小范围内");
    }
    return;
  }

  if (INVITE_REQUIRED) {
    console.warn("[gate] 已配置邀请码但 GATE_ENFORCE=0，内测门禁当前关闭");
    return;
  }

  const message = [
    "未配置 GATE_INVITE_CODES，内测门禁关闭 ——",
    "  生产环境默认拒绝以此状态启动（任何人都能直接调写接口）。",
    "  修复：设置 GATE_INVITE_CODES=<至少 8 位的邀请码，逗号分隔可配多个>；",
    "        或显式设置 GATE_ALLOW_DISABLED=1 明确承担风险。"
  ].join("\n");

  if (IS_PROD && process.env.GATE_ALLOW_DISABLED !== "1") {
    if (typeof fatal === "function") return fatal(message);
    try {
      fs.writeSync(2, `[gate] ${message}\n`);
    } catch { /* stderr 不可写时忽略 */ }
    process.exit(1);
  }
  if (process.env.GATE_ALLOW_DISABLED === "1") {
    console.warn("[gate] GATE_ALLOW_DISABLED=1：已显式放行，门禁关闭，写接口对全网开放");
  } else {
    console.warn("[gate] 内测门禁关闭（非生产环境的默认行为；生产环境会拒绝启动）");
  }
  return undefined;
}

module.exports = {
  logConfig,
  publicConfig,
  hasSession,
  issueChallenge,
  verify,
  guardWrite,
  issueCookie,
  clearCookie,
  COOKIE_NAME,
  ENABLED,
  ENFORCE,
  INVITE_REQUIRED,
  TTL_SECONDS,
  CHALLENGE_TTL_SECONDS,
  pendingCount: () => pending.size
};
