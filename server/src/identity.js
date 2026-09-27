"use strict";

/**
 * 后台实名（手机号验证）。
 *
 * 定位：**这不是用户账号系统。**没有密码、没有昵称、没有个人主页、没有跨设备登录。
 * 它只解决一个合规问题 —— 前台匿名展示，但平台必须能追溯到发布者，
 * 出事时能拿出「我收集并验证了身份标识」的凭据。
 *
 * 与 challenge.js 的分工：
 *   challenge.js  回答「你是不是机器人」 → Cloudflare Turnstile
 *   identity.js   回答「你是谁、能不能找到你」 → 手机号 + 短信验证码
 * 两者都要过，才允许发布内容。
 *
 * 隐私设计（PDPO / 个保法都要求数据最小化）：
 *   * 手机号**不落盘明文**，只存 HMAC-SHA256(归一化号码, IDENTITY_SECRET)；
 *   * 明文只存在于「提交验证码」这一次请求的内存里，处理完即释放，不写日志；
 *   * 验证码本身也只存哈希，比对用常量时间；
 *   * 数据库被拖走时，攻击者拿到的是哈希 + 脱敏号码（138****8000），
 *     在没有密钥的情况下无法还原号码；
 *   * 运营方需要联系发布者时，凭 phone_masked + 时间 + 短信网关发送记录反查。
 *
 * 防滥用：
 *   * 同一号码 60 秒内只能发一次、每日上限；同一 IP 每小时上限；
 *   * 验证码 10 分钟过期、一次性消费、错 5 次作废（防爆破）；
 *   * 「发码」与「校验」的响应刻意统一，避免被用来枚举哪些号码已注册。
 */

const crypto = require("crypto");
const db = require("./db");
const sms = require("./sms");

const IS_PROD = process.env.NODE_ENV === "production";

/* ───────────────────────────── 配置 ───────────────────────────── */

const SECRET = process.env.IDENTITY_SECRET
  || process.env.IP_HASH_SECRET
  || crypto.randomBytes(32).toString("hex");

/** 是否强制实名：显式配置优先，否则生产环境默认开启 */
const CONFIGURED = Boolean(process.env.IDENTITY_SECRET || process.env.IP_HASH_SECRET);
const ENFORCE = process.env.IDENTITY_ENFORCE === "1"
  || (process.env.IDENTITY_ENFORCE !== "0" && IS_PROD);

/** 是否要求实名后才能**阅读**（默认否：读多写少，挡阅读会显著伤害可用性） */
const REQUIRE_FOR_READS = process.env.IDENTITY_REQUIRE_FOR_READS === "1";

const CODE_TTL_MS = Number(process.env.IDENTITY_CODE_TTL_MS || 10 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.IDENTITY_SESSION_TTL_MS || 180 * 86400000); // 半年
const RESEND_INTERVAL_MS = Number(process.env.IDENTITY_RESEND_INTERVAL_MS || 60 * 1000);
const MAX_PER_DAY_PER_PHONE = Number(process.env.IDENTITY_MAX_PER_DAY || 8);
const MAX_PER_HOUR_PER_IP = Number(process.env.IDENTITY_MAX_PER_HOUR_IP || 10);
const MAX_CODE_ATTEMPTS = Number(process.env.IDENTITY_MAX_ATTEMPTS || 5);

const CONSENT_VERSION = String(process.env.IDENTITY_CONSENT_VERSION || "v1.0");
const COOKIE_NAME = process.env.IDENTITY_COOKIE || "od_identity";
const COOKIE_SECURE = process.env.IDENTITY_COOKIE_SECURE === "1" || IS_PROD;

/* ───────────────────────── 手机号处理 ───────────────────────── */

/**
 * 归一化为带国家码的纯数字（E.164 无加号）。
 * 只接受中国大陆与香港号码 —— 与部署地匹配，避免变成任意短信轰炸工具。
 *
 * @returns {{ ok: true, e164: string, country: string } | { ok: false, error: string }}
 */
function normalizePhone(raw) {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "请输入手机号" };

  // 去掉常见分隔符与括号，保留前导 +
  s = s.replace(/[\s\-()（）.]/g, "");
  if (!/^\+?\d{5,20}$/.test(s)) return { ok: false, error: "手机号格式不正确" };

  const plus = s.startsWith("+");
  let digits = plus ? s.slice(1) : s;

  // 带 + 或 00 前缀：按国际格式，必须显式属于支持的国家码
  if (plus || digits.startsWith("00")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("86") && digits.length === 13) {
      return validateCN(digits.slice(2));
    }
    if (digits.startsWith("852") && digits.length === 11) {
      return validateHK(digits.slice(3));
    }
    return { ok: false, error: "目前只支持中国大陆（+86）与香港（+852）手机号" };
  }

  // 不带前缀：先按本地号码长度判断
  if (digits.length === 11) return validateCN(digits);
  if (digits.length === 8) return validateHK(digits);
  return { ok: false, error: "手机号格式不正确（大陆 11 位 / 香港 8 位）" };
}

function validateCN(digits) {
  if (!/^1[3-9]\d{9}$/.test(digits)) return { ok: false, error: "中国大陆手机号格式不正确" };
  return { ok: true, e164: `86${digits}`, country: "86" };
}

function validateHK(digits) {
  if (!/^[2-9]\d{7}$/.test(digits)) return { ok: false, error: "香港手机号格式不正确" };
  return { ok: true, e164: `852${digits}`, country: "852" };
}

/** 脱敏展示：138****8000 / 852****1234（仅供后台人工核对） */
function maskPhone(e164) {
  const country = e164.startsWith("852") ? "852" : "86";
  const rest = e164.slice(country.length);
  return `${country} ${rest.slice(0, 2)}****${rest.slice(-2)}`;
}

/** 不可逆标识。与 IP 哈希用同一套思路，但可以独立配密钥。 */
function phoneHash(e164) {
  return crypto.createHmac("sha256", SECRET).update(`phone:${e164}`).digest("hex").slice(0, 32);
}

/** 日志里也不能出现完整号码 */
function maskForLog(e164) {
  const s = String(e164 || "");
  return s.length < 7 ? "***" : `${s.slice(0, 4)}****${s.slice(-3)}`;
}

/* ────────────────────────── 验证码 ────────────────────────── */

function hashCode(phoneHashValue, code) {
  return crypto.createHmac("sha256", SECRET).update(`code:${phoneHashValue}:${code}`).digest("hex");
}

function generateCode() {
  // 6 位数字，用 CSPRNG 取模时做拒绝采样，避免模偏差
  const max = 1000000;
  const limit = Math.floor(0xffffffff / max) * max;
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % max).padStart(6, "0");
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ────────────────────────── cookie ────────────────────────── */

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

/** 会话值 = identityId.exp 签名；绑定 identityId，防止伪造或替换 */
function sign(identityId, exp) {
  return crypto.createHmac("sha256", SECRET).update(`sess:${identityId}.${exp}`).digest("base64url");
}

function issueCookie(identityId) {
  const exp = Date.now() + SESSION_TTL_MS;
  const value = `${identityId}.${exp}.${sign(identityId, exp)}`;
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie() {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * 读取当前请求的实名身份。
 * @returns {{ id: number, phone_masked: string, country_code: string|null, verified_at: number } | null}
 */
function current(req) {
  if (!ENFORCE) return null;
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;

  const parts = String(raw).split(".");
  if (parts.length !== 3) return null;
  const [rawId, rawExp, mac] = parts;
  const id = Number(rawId);
  const exp = Number(rawExp);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(exp) || exp <= Date.now()) return null;
  if (!timingSafeEqualStr(mac, sign(id, exp))) return null;

  const row = db
    .prepare("SELECT id, phone_masked, country_code, verified_at FROM identities WHERE id = ?")
    .get(id);
  if (!row) return null;

  // 更新活跃时间，但不改 verified_at
  db.prepare("UPDATE identities SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  return row;
}

/* ───────────────────── 发码 / 校验（核心）───────────────────── */

/**
 * 申请验证码。
 * @returns {Promise<{ ok: boolean, error?: string, retryAfter?: number, devCode?: string }>}
 */
async function requestCode({ phone, ipHash, ttlMinutes = Math.round(CODE_TTL_MS / 60000) }) {
  const normalized = normalizePhone(phone);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const hash = phoneHash(normalized.e164);
  const now = Date.now();

  // 同号码重发间隔
  const last = db
    .prepare("SELECT created_at FROM identity_codes WHERE phone_hash = ? ORDER BY id DESC LIMIT 1")
    .get(hash);
  if (last && now - last.created_at < RESEND_INTERVAL_MS) {
    return {
      ok: false,
      error: "请求过于频繁，请稍后再试",
      retryAfter: Math.ceil((RESEND_INTERVAL_MS - (now - last.created_at)) / 1000)
    };
  }

  // 同号码每日上限（防短信轰炸与费用失控）
  const dayCount = db
    .prepare("SELECT COUNT(*) AS n FROM identity_codes WHERE phone_hash = ? AND created_at > ?")
    .get(hash, now - 86400000).n;
  if (dayCount >= MAX_PER_DAY_PER_PHONE) {
    return { ok: false, error: "该号码今日验证次数过多，请明天再试" };
  }

  // 同 IP 每小时上限
  const ipCount = db
    .prepare("SELECT COUNT(*) AS n FROM identity_codes WHERE ip_hash = ? AND created_at > ?")
    .get(ipHash, now - 3600000).n;
  if (ipCount >= MAX_PER_HOUR_PER_IP) {
    return { ok: false, error: "当前网络请求过于频繁，请稍后再试" };
  }

  const code = generateCode();

  // 旧码作废：只保留最新一条可用，避免「多码并存」扩大爆破面
  const issue = db.transaction(() => {
    db.prepare("UPDATE identity_codes SET consumed_at = ? WHERE phone_hash = ? AND consumed_at IS NULL")
      .run(now, hash);
    db.prepare(
      `INSERT INTO identity_codes (phone_hash, code_hash, expires_at, ip_hash, created_at)
       VALUES (?,?,?,?,?)`
    ).run(hash, hashCode(hash, code), now + CODE_TTL_MS, ipHash, now);
  });
  issue();

  const sent = await sms.send({ phone: normalized.e164, code, ttlMinutes });
  if (!sent.ok) {
    // 发送失败就把这条码作废，别让用户拿着一个收不到的码反复试
    db.prepare("UPDATE identity_codes SET consumed_at = ? WHERE phone_hash = ? AND consumed_at IS NULL")
      .run(now, hash);
    return { ok: false, error: sent.error || "短信发送失败，请稍后重试" };
  }

  return { ok: true, masked: maskPhone(normalized.e164) };
}

/**
 * 校验验证码并落一条身份记录。
 *
 * 无论号码此前是否验证过，提交成功都返回同一形状，避免被用来探测号码是否已注册。
 *
 * @returns {Promise<{ ok: boolean, error?: string, identity?: object, cookie?: string }>}
 */
async function verifyCode({ phone, code, ipHash, uaHash }) {
  const normalized = normalizePhone(phone);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  if (!/^\d{6}$/.test(String(code || "").trim())) {
    return { ok: false, error: "请输入 6 位验证码" };
  }

  const hash = phoneHash(normalized.e164);
  const now = Date.now();
  const input = String(code).trim();

  const row = db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at FROM identity_codes
       WHERE phone_hash = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    .get(hash);

  if (!row) return { ok: false, error: "验证码已失效，请重新获取" };
  if (row.expires_at <= now) {
    db.prepare("UPDATE identity_codes SET consumed_at = ? WHERE id = ?").run(now, row.id);
    return { ok: false, error: "验证码已过期，请重新获取" };
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    db.prepare("UPDATE identity_codes SET consumed_at = ? WHERE id = ?").run(now, row.id);
    return { ok: false, error: "错误次数过多，请重新获取验证码" };
  }

  if (!timingSafeEqualStr(hashCode(hash, input), row.code_hash)) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      db.prepare("UPDATE identity_codes SET attempts = ?, consumed_at = ? WHERE id = ?")
        .run(attempts, now, row.id);
      return { ok: false, error: "错误次数过多，请重新获取验证码" };
    }
    db.prepare("UPDATE identity_codes SET attempts = ? WHERE id = ?").run(attempts, row.id);
    return { ok: false, error: `验证码不正确（还可尝试 ${MAX_CODE_ATTEMPTS - attempts} 次）` };
  }

  const masked = maskPhone(normalized.e164);

  const apply = db.transaction(() => {
    db.prepare("UPDATE identity_codes SET consumed_at = ? WHERE id = ?").run(now, row.id);

    const existing = db.prepare("SELECT id FROM identities WHERE phone_hash = ?").get(hash);
    if (existing) {
      db.prepare(
        `UPDATE identities
            SET verified_at = ?, last_seen_at = ?, consent_version = ?, consent_at = ?
          WHERE id = ?`
      ).run(now, now, CONSENT_VERSION, now, existing.id);
      return existing.id;
    }

    const info = db.prepare(
      `INSERT INTO identities
         (phone_hash, phone_masked, country_code, method, verified_at, consent_version, consent_at,
          last_seen_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(hash, masked, normalized.country, "phone", now, CONSENT_VERSION, now, now, now);
    return Number(info.lastInsertRowid);
  });

  const identityId = apply();
  return {
    ok: true,
    identity: {
      id: identityId,
      phoneMasked: masked,
      countryCode: normalized.country,
      verifiedAt: now,
      consentVersion: CONSENT_VERSION
    },
    cookie: issueCookie(identityId)
  };
}

/* ─────────────────────── 发布时记账 ─────────────────────── */

function recordPost(identityId) {
  if (!identityId) return;
  db.prepare("UPDATE identities SET post_count = post_count + 1, last_seen_at = ? WHERE id = ?")
    .run(Date.now(), identityId);
}

function recordComment(identityId) {
  if (!identityId) return;
  db.prepare("UPDATE identities SET comment_count = comment_count + 1, last_seen_at = ? WHERE id = ?")
    .run(Date.now(), identityId);
}

/** 运营方追溯：从身份一路查到它发布过的全部内容（含待审与已下架） */
function lookup(identityId) {
  const id = Number(identityId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const identity = db
    .prepare(
      `SELECT id, phone_masked, country_code, method, verified_at, consent_version, consent_at,
              post_count, comment_count, last_seen_at, created_at
         FROM identities WHERE id = ?`
    )
    .get(id);
  if (!identity) return null;

  const posts = db
    .prepare("SELECT id, cat, body, status, created_at, reviewed_at FROM posts WHERE identity_id = ? ORDER BY id DESC LIMIT 200")
    .all(id);
  const comments = db
    .prepare("SELECT id, post_id, body, status, created_at FROM comments WHERE identity_id = ? ORDER BY id DESC LIMIT 200")
    .all(id);

  return { identity, posts, comments };
}

/* ───────────────────────────── 对外 ───────────────────────────── */

function publicConfig() {
  return {
    required: ENFORCE,
    requireForReads: REQUIRE_FOR_READS,
    consentVersion: CONSENT_VERSION,
    codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
    resendIntervalSeconds: Math.round(RESEND_INTERVAL_MS / 1000),
    provider: sms.provider,           // 前端可以据此提示「开发模式不会真的发短信」
    supportedCountries: ["86", "852"]
  };
}

function logConfig({ fatal } = {}) {
  if (!ENFORCE) {
    console.warn("[identity] 后台实名未启用（IDENTITY_ENFORCE=0）");
    return;
  }
  if (!CONFIGURED) {
    const message = [
      "后台实名已启用，但没有配置 IDENTITY_SECRET / IP_HASH_SECRET。",
      "  已临时使用进程内随机密钥：重启后所有身份哈希都会变化，",
      "  之前验证过的用户会全部失效，且无法再关联到历史内容。",
      "  生产环境请务必配置固定密钥。",
    ].join("\n");
    console.warn(`[identity] ${message}`);
  }

  const usable = sms.assertUsable();
  if (!usable.ok) {
    if (typeof fatal === "function") return fatal(usable.fatal);
    console.error(`[identity] ${usable.fatal}`);
    process.exit(1);
  }

  console.log(`[identity] 后台实名已启用（短信通道 ${sms.provider}，验证码 ${Math.round(CODE_TTL_MS / 60000)} 分钟有效）`);
  if (sms.provider === "log") {
    console.warn("[identity] 当前为 log 模式：验证码只写服务端日志，不会真的发送短信");
  }
}

module.exports = {
  logConfig,
  publicConfig,
  normalizePhone,
  maskPhone,
  phoneHash,
  requestCode,
  verifyCode,
  current,
  recordPost,
  recordComment,
  lookup,
  issueCookie,
  clearCookie,
  COOKIE_NAME,
  ENFORCE,
  REQUIRE_FOR_READS,
  CONSENT_VERSION
};
