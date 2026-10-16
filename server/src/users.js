"use strict";

/**
 * 账号体系：用户、头衔、等级、会话、邮箱验证码、注册令牌。
 *
 * 三条设计原则：
 *
 *   1. **对外只用 uuid。** 自增 id 会泄露注册顺序，也不能跨库迁移；
 *      所有对外接口（主页、好友、私信）一律用 uuid。
 *
 *   2. **敏感值只存哈希。** 验证码存 HMAC，会话 token 存 SHA-256；
 *      数据库被拖走也不能直接拿来登录。
 *
 *   3. **学校选定不可改。** school 只在注册时写入，updateProfile 不接受该字段，
 *      后台也没有改学校的入口 —— 这是产品承诺，不是「忘了做」。
 */

const crypto = require("crypto");
const db = require("./db");
const config = require("./config");

/* ───────────────────────────── 密钥 ───────────────────────────── */

let SECRET = "";

/**
 * 由 server.js 在启动时注入（与 IP 哈希共用 IP_HASH_SECRET，
 * 避免再多一个必须配置的必填项）。没注入时用一个进程内随机串兜底：
 * 影响面只有「重启后尚未使用的验证码失效」，不影响会话。
 */
function configure({ secret } = {}) {
  if (secret) SECRET = String(secret);
}
if (!SECRET) SECRET = crypto.randomBytes(32).toString("hex");

function hmac(value) {
  return crypto.createHmac("sha256", SECRET).update(String(value)).digest("hex");
}

/* ───────────────────────────── 常量 ───────────────────────────── */

const AVATARS = [
  "leaf", "moon", "star", "cloud", "cat", "fox", "whale", "sakura",
  "book", "coffee", "music", "camera", "rocket", "ball", "rain", "sun"
];
const AVATAR_SET = new Set(AVATARS);

const NICKNAME_MIN = 2;
const NICKNAME_MAX = 16;
const BIO_MAX = 60;

const MAX_LEVEL = 99;
const EXP_STEP = 25; // expForLevel(n) = EXP_STEP * n * (n-1)

/** 经验规则：一次写清楚，避免散落在各个路由里 */
const EXP = {
  post_approved: 10,
  comment_approved: 2,
  thread_created: 5,
  reply_created: 2,
  like_received: 1,
  daily_login: 1
};

/** 升到第 n 级所需累计经验；n=1 时为 0 */
function expForLevel(level) {
  const n = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return EXP_STEP * n * (n - 1);
}

/** 由经验反推等级（三角曲线，1 级起步，上限 99） */
function levelFromExp(exp) {
  const e = Math.max(0, Number(exp) || 0);
  const level = Math.floor((1 + Math.sqrt(1 + (4 * e) / EXP_STEP)) / 2);
  return Math.max(1, Math.min(MAX_LEVEL, level));
}

/* ───────────────────────────── 头衔缓存 ───────────────────────────── */

let titleCache = null;

/** 任何头衔写操作后调用：下次读取重新查库（头衔是极小表，代价可忽略） */
function bumpTitles() {
  titleCache = null;
}

function allTitles() {
  if (!titleCache) {
    titleCache = db.prepare(
      "SELECT id, name, color, min_level, auto, sort FROM user_titles ORDER BY sort ASC, min_level ASC, id ASC"
    ).all();
  }
  return titleCache;
}

/**
 * 解析用户的有效头衔。
 * 手动指定优先（title_id 非空即用它）；否则取「等级已够」的自动头衔中
 * min_level 最高、sort 最靠后的那个 —— 等级越高头衔越"高阶"。
 */
function titleFor(row, titles = allTitles()) {
  if (!row) return null;
  if (row.title_id) {
    const manual = titles.find((t) => t.id === row.title_id);
    if (manual) return { name: manual.name, color: manual.color || "" };
  }
  let best = null;
  for (const t of titles) {
    if (!t.auto) continue;
    if (t.min_level > row.level) continue;
    if (!best || t.min_level > best.min_level || (t.min_level === best.min_level && t.sort >= best.sort)) {
      best = t;
    }
  }
  return best ? { name: best.name, color: best.color || "" } : null;
}

/* ───────────────────────────── 学校名单 ───────────────────────────── */

/**
 * 学校名单来自数据库表 schools，**由后台维护**（不是文件，也不是代码常量）。
 *
 * 缓存 30 秒：注册页与 /api/schools 会频繁读它，但名单变动极少；
 * 后台每次增删改都会显式 bumpSchools() 立即失效，所以运营改完马上生效，
 * 不需要等缓存过期。表为空时 isValidSchool 一律返回 false ——
 * 「先让管理员配学校，再让用户注册」比「没配就随便填」更符合产品承诺。
 */
const schoolsState = { list: [], set: new Set(), loadedAt: 0 };

function bumpSchools() {
  schoolsState.loadedAt = 0;
}

function loadSchools(force = false) {
  const now = Date.now();
  if (!force && schoolsState.loadedAt && now - schoolsState.loadedAt < 30000) return schoolsState;

  const rows = db.prepare("SELECT name FROM schools WHERE active = 1 ORDER BY sort ASC, name ASC").all();
  schoolsState.list = rows.map((r) => r.name);
  schoolsState.set = new Set(schoolsState.list);
  schoolsState.loadedAt = now;
  return schoolsState;
}

function schoolList() {
  return loadSchools().list.slice();
}

function normalizeSchool(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
}

/** 学校是否合法：必须在后台配置的启用名单内（名单为空则谁都不能注册，见上） */
function isValidSchool(raw) {
  const name = normalizeSchool(raw);
  if (name.length < 2 || name.length > 30) return false;
  loadSchools();
  return schoolsState.set.has(name);
}

/* ───────────────────────── 学校管理（后台）───────────────────────── */

function listSchoolsAdmin() {
  const rows = db.prepare("SELECT id, name, sort, active, created_at FROM schools ORDER BY sort ASC, name ASC").all();
  const counts = db.prepare("SELECT school AS name, COUNT(*) AS n FROM users GROUP BY school").all();
  const map = new Map(counts.map((c) => [c.name, c.n]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sort: r.sort,
    active: Boolean(r.active),
    userCount: map.get(r.name) || 0,
    createdAt: r.created_at
  }));
}

function createSchool({ name, sort = 0 }) {
  const clean = normalizeSchool(name).slice(0, 30);
  if (clean.length < 2) return { ok: false, error: "invalid_name" };
  const exists = db.prepare("SELECT id, active FROM schools WHERE name = ?").get(clean);
  if (exists) {
    // 已存在但被停用 → 视为重新启用，而不是报错（运营的常见动作）
    if (!exists.active) {
      db.prepare("UPDATE schools SET active = 1, sort = ? WHERE id = ?").run(Number(sort) || 0, exists.id);
      bumpSchools();
      return { ok: true, id: exists.id, reactivated: true };
    }
    return { ok: false, error: "duplicate_name" };
  }
  const info = db.prepare("INSERT INTO schools (name, sort, active, created_at) VALUES (?,?,1,?)")
    .run(clean, Number(sort) || 0, Date.now());
  bumpSchools();
  return { ok: true, id: info.lastInsertRowid };
}

function updateSchool(id, patch) {
  const row = db.prepare("SELECT id, name, sort, active FROM schools WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };

  const sets = [];
  const args = [];
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    const clean = normalizeSchool(patch.name).slice(0, 30);
    if (clean.length < 2) return { ok: false, error: "invalid_name" };
    const dup = db.prepare("SELECT id FROM schools WHERE name = ? AND id <> ?").get(clean, row.id);
    if (dup) return { ok: false, error: "duplicate_name" };
    sets.push("name = ?");
    args.push(clean);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sort")) {
    sets.push("sort = ?");
    args.push(Number(patch.sort) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "active")) {
    sets.push("active = ?");
    args.push(patch.active ? 1 : 0);
  }
  if (!sets.length) return { ok: true, unchanged: true };

  args.push(row.id);
  db.prepare(`UPDATE schools SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  bumpSchools();
  return { ok: true };
}

/**
 * 删除学校。已选过它的用户**不受影响**（users.school 是校名快照，不是外键）——
 * 这正是「学校选定后不可更改」这条承诺能成立的前提。
 */
function deleteSchool(id) {
  const row = db.prepare("SELECT id FROM schools WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };
  db.prepare("DELETE FROM schools WHERE id = ?").run(row.id);
  bumpSchools();
  return { ok: true };
}

/* ───────────────────────────── 邮箱 ───────────────────────────── */

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function normalizeEmail(raw) {
  return String(raw == null ? "" : raw).trim().toLowerCase();
}

function isValidEmail(raw) {
  const email = normalizeEmail(raw);
  return email.length <= 254 && EMAIL_RE.test(email);
}

/* ───────────────────────────── 用户读写 ───────────────────────────── */

const USER_COLUMNS = `id, uuid, email, nickname, nickname_flagged, school, avatar, bio,
  title_id, level, exp, status, muted_until, last_nickname_at, ip_hash, ua_hash,
  created_at, last_login_at, last_seen_at`;

function makeUuid() {
  return crypto.randomUUID();
}

/**
 * 建号。uuid 由服务端生成（不接受客户端传入），school 在此写死后不再可变。
 */
function createUser({ email, nickname, school, avatar = "", ipHash = null, uaHash = null }) {
  const now = Date.now();
  const uuid = makeUuid();
  const nick = String(nickname).trim();
  const info = db.prepare(
    `INSERT INTO users (uuid, email, nickname, school, avatar, ip_hash, ua_hash, created_at, last_login_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(uuid, normalizeEmail(email), nick, normalizeSchool(school), AVATAR_SET.has(avatar) ? avatar : "", ipHash, uaHash, now, now, now);
  return findById(info.lastInsertRowid);
}

function findByEmail(email) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(normalizeEmail(email)) || null;
}

function findByUuid(uuid) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE uuid = ?`).get(String(uuid || "")) || null;
}

function findById(id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(Number(id) || 0) || null;
}

/** 会话校验用：顺带把 status 带出来，被封禁的账号立刻失效 */
function isActive(row) {
  return Boolean(row) && row.status !== "banned";
}

/** 对外用户对象。context 传 'self' 时附带只有本人可见的字段。 */
function publicUser(row, { self = false, stats = null, titles = allTitles() } = {}) {
  if (!row) return null;
  const out = {
    uuid: row.uuid,
    nickname: row.nickname,
    avatar: row.avatar || "",
    bio: row.bio || "",
    school: row.school,
    title: titleFor(row, titles),
    level: row.level,
    exp: row.exp,
    createdAt: row.created_at
  };
  if (stats) out.stats = stats;
  if (self) {
    out.email = row.email;
    out.status = row.status;
    out.nicknameCooldownUntil = row.last_nickname_at
      ? row.last_nickname_at + config.NICKNAME_COOLDOWN_H * 3600000
      : 0;
    out.nextLevelExp = row.level >= MAX_LEVEL ? null : expForLevel(row.level + 1);
  }
  return out;
}

/** 后台看到的完整信息（含哈希后的 IP/UA，不含任何明文凭据） */
function adminUser(row, extra = {}) {
  if (!row) return null;
  const titles = allTitles();
  const counts = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE user_id = @id)         AS posts,
       (SELECT COUNT(*) FROM comments WHERE user_id = @id)      AS comments,
       (SELECT COUNT(*) FROM forum_threads WHERE author_id = @id) AS threads,
       (SELECT COUNT(*) FROM forum_replies WHERE author_id = @id) AS replies,
       (SELECT COUNT(*) FROM dm_messages WHERE sender_id = @id)   AS dmsSent,
       (SELECT COUNT(*) FROM friendships
          WHERE status = 'accepted' AND (requester_id = @id OR addressee_id = @id)) AS friends`
  ).get({ id: row.id });

  return {
    id: row.id,
    uuid: row.uuid,
    email: row.email,
    nickname: row.nickname,
    nicknameFlagged: row.nickname_flagged || "",
    school: row.school,
    avatar: row.avatar || "",
    bio: row.bio || "",
    titleId: row.title_id || null,
    title: titleFor(row, titles),
    level: row.level,
    exp: row.exp,
    status: row.status,
    mutedUntil: row.muted_until || 0,
    lastNicknameAt: row.last_nickname_at || 0,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || 0,
    lastSeenAt: row.last_seen_at || 0,
    ipHash: row.ip_hash || "",
    uaHash: row.ua_hash || "",
    counts,
    ...extra
  };
}

/** 记一次登录：刷新 last_login_at / last_seen_at，并按天发放登录经验 */
function touchLogin(userId) {
  const now = Date.now();
  const row = db.prepare("SELECT last_login_at FROM users WHERE id = ?").get(userId);
  db.prepare("UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, userId);

  const last = row && row.last_login_at ? row.last_login_at : 0;
  const sameDay = last > 0 && new Date(last).toDateString() === new Date(now).toDateString();
  if (!sameDay) addExp(userId, EXP.daily_login);
}

function touchSeen(userId) {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(Date.now(), userId);
}

/**
 * 加经验并同步等级。返回 {exp, level, levelUp}。
 * 之所以把等级在写入时算好存下来：等级读多写少，实时算会让列表接口多一次 sqrt，
 * 更麻烦的是排序/筛选会变得没法用索引。
 */
function addExp(userId, delta) {
  const d = Math.floor(Number(delta) || 0);
  if (!d) {
    const row = findById(userId);
    return row ? { exp: row.exp, level: row.level, levelUp: false } : null;
  }
  const row = findById(userId);
  if (!row) return null;
  const exp = Math.max(0, row.exp + d);
  const level = levelFromExp(exp);
  db.prepare("UPDATE users SET exp = ?, level = ? WHERE id = ?").run(exp, level, userId);
  return { exp, level, levelUp: level > row.level, prevLevel: row.level };
}

/**
 * 更新可个性化字段。**故意不接受 school / level / exp / status / uuid**：
 * 个性化只允许昵称、头像、简介这三项，其余是服务端或管理员的职责。
 */
function updateProfile(userId, patch) {
  const row = findById(userId);
  if (!row) return { ok: false, error: "not_found" };

  const sets = [];
  const args = [];

  if (Object.prototype.hasOwnProperty.call(patch, "nickname")) {
    const nickname = String(patch.nickname).trim();
    if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
      return { ok: false, error: "nickname_length" };
    }
    if (nickname !== row.nickname) {
      const cooldownMs = config.NICKNAME_COOLDOWN_H * 3600000;
      const last = row.last_nickname_at || 0;
      if (cooldownMs > 0 && last && Date.now() - last < cooldownMs) {
        return {
          ok: false,
          error: "nickname_cooldown",
          retryAfter: Math.ceil((cooldownMs - (Date.now() - last)) / 1000)
        };
      }
      sets.push("nickname = ?", "last_nickname_at = ?");
      args.push(nickname, Date.now());
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "avatar")) {
    const avatar = String(patch.avatar || "");
    if (avatar && !AVATAR_SET.has(avatar)) return { ok: false, error: "invalid_avatar" };
    sets.push("avatar = ?");
    args.push(avatar);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "bio")) {
    const bio = String(patch.bio || "").replace(/\s+/g, " ").trim();
    if (bio.length > BIO_MAX) return { ok: false, error: "bio_too_long" };
    sets.push("bio = ?");
    args.push(bio);
  }

  if (!sets.length) return { ok: true, user: row, unchanged: true };

  args.push(userId);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return { ok: true, user: findById(userId) };
}

/**
 * 批量取用户行：论坛/私信列表要在一页里显示多个作者，
 * 逐个 findById 会变成 N+1 查询。这里一次 IN (...) 拿回来，再在内存里组装。
 */
function rowsByIds(ids) {
  const list = Array.from(new Set((ids || []).map((n) => Number(n)).filter((n) => n > 0)));
  if (!list.length) return new Map();
  const placeholders = list.map(() => "?").join(",");
  const rows = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders})`).all(...list);
  return new Map(rows.map((r) => [r.id, r]));
}

/** 个人主页统计（只有打开主页时才查，列表接口不查） */
function statsFor(userId) {
  return db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE user_id = ?)              AS posts,
       (SELECT COUNT(*) FROM comments WHERE user_id = ?)           AS comments,
       (SELECT COUNT(*) FROM forum_threads WHERE author_id = ?)    AS threads,
       (SELECT COUNT(*) FROM forum_replies WHERE author_id = ?)    AS replies,
       (SELECT COUNT(*) FROM friendships
          WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)) AS friends`
  ).get(userId, userId, userId, userId, userId, userId);
}

/* ───────────────────────────── 会话 ───────────────────────────── */

function sessionTtlMs() {
  return config.SESSION_DAYS * 86400000;
}

function createSession(userId, { ipHash = null, uaHash = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip_hash, ua_hash)
     VALUES (?,?,?,?,?,?,?)`
  ).run(hashToken(token), userId, now, now + sessionTtlMs(), now, ipHash, uaHash);
  return { token, expiresAt: now + sessionTtlMs() };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** 解析 Cookie 头里的会话 token */
function tokenFromCookie(header) {
  const raw = String(header || "");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== config.SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

/**
 * 用 token 换用户。命中后节流刷新 last_seen_at（60 秒一次）：
 * 每个请求都写一次会把单核数据库的写入预算吃光。
 */
function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    "SELECT user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?"
  ).get(hashToken(token));
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  const user = findById(row.user_id);
  if (!user) return null;
  if (now - row.last_seen_at > 60000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, hashToken(token));
    touchSeen(user.id);
  }
  return isActive(user) ? user : null;
}

function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

function destroyUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function pruneSessions() {
  const info = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  return info.changes;
}

/** Set-Cookie 值：HttpOnly + SameSite=Lax + 跟随协议决定 Secure */
function sessionCookie(token, secure) {
  const parts = [
    config.SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(sessionTtlMs() / 1000)
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(secure) {
  const parts = [config.SESSION_COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/* ───────────────────────────── 验证码 ───────────────────────────── */

function randomCode() {
  // 6 位数字，用 CSPRNG；不用 Math.random
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/** 该邮箱最近一次发码时间（用于重发间隔与小时配额判断） */
function lastCodeAt(email) {
  const row = db.prepare(
    "SELECT created_at FROM auth_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  ).get(normalizeEmail(email));
  return row ? row.created_at : 0;
}

function codesInLastHour(email) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM auth_codes WHERE email = ? AND created_at > ?"
  ).get(normalizeEmail(email), Date.now() - 3600000);
  return row ? row.n : 0;
}

/** 发码：旧的未用验证码立即作废（同一邮箱同时只有一个有效码） */
function issueCode(email, { ipHash = null, purpose = "login" } = {}) {
  const normalized = normalizeEmail(email);
  const code = randomCode();
  const now = Date.now();
  db.prepare("UPDATE auth_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL")
    .run(now, normalized);
  db.prepare(
    `INSERT INTO auth_codes (email, code_hash, purpose, ip_hash, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`
  ).run(normalized, hmac(normalized + ":" + code), purpose, ipHash, now, now + config.CODE_TTL * 1000);
  return { code, expiresAt: now + config.CODE_TTL * 1000, ttlSeconds: config.CODE_TTL };
}

/**
 * 校验验证码。失败返回 remaining（剩余尝试次数），5 次即作废 ——
 * 否则 6 位码可以被在线暴力枚举。
 */
function verifyCode(email, rawCode) {
  const normalized = normalizeEmail(email);
  const code = String(rawCode == null ? "" : rawCode).trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "invalid_code", remaining: null };

  const row = db.prepare(
    `SELECT id, code_hash, attempts, expires_at FROM auth_codes
      WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).get(normalized);

  if (!row) return { ok: false, error: "code_expired" };
  if (row.expires_at <= Date.now()) {
    db.prepare("UPDATE auth_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
    return { ok: false, error: "code_expired" };
  }

  const attempts = row.attempts + 1;
  if (row.code_hash !== hmac(normalized + ":" + code)) {
    const exhausted = attempts >= 5;
    db.prepare("UPDATE auth_codes SET attempts = ?, consumed_at = ? WHERE id = ?")
      .run(attempts, exhausted ? Date.now() : null, row.id);
    return { ok: false, error: exhausted ? "code_expired" : "invalid_code", remaining: Math.max(0, 5 - attempts) };
  }

  db.prepare("UPDATE auth_codes SET consumed_at = ?, attempts = ? WHERE id = ?").run(Date.now(), attempts, row.id);
  return { ok: true };
}

/* ─────────────────────────── 注册令牌 ─────────────────────────── */

const REGISTER_TTL_MS = 15 * 60 * 1000;

function issueRegisterToken(email, { ipHash = null } = {}) {
  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO register_tokens (token_hash, email, ip_hash, created_at, expires_at) VALUES (?,?,?,?,?)"
  ).run(hashToken(token), normalizeEmail(email), ipHash, now, now + REGISTER_TTL_MS);
  return { token, expiresAt: now + REGISTER_TTL_MS };
}

/**
 * 校验注册令牌但**不消费**。
 *
 * 为什么拆成两步：注册要在「填昵称 + 选学校」之后才提交，而这两步都可能失败
 * （昵称命中违禁词、学校不在名单里）。如果一进来就消费令牌，用户改一个字重提
 * 就得重新走一遍「发验证码 → 收邮件 → 填码」，体验非常糟。
 * 因此校验与消费分开：**只有真正建号成功才把它标记为已用**。
 */
function peekRegisterToken(token) {
  const row = db.prepare(
    "SELECT email, expires_at, used_at FROM register_tokens WHERE token_hash = ?"
  ).get(hashToken(String(token || "")));
  if (!row || row.used_at || row.expires_at <= Date.now()) return { ok: false, error: "invalid_token" };
  return { ok: true, email: row.email };
}

/** 一次性消费：建号成功后调用，重放即失效 */
function consumeRegisterToken(token) {
  const info = db.prepare(
    "UPDATE register_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
  ).run(Date.now(), hashToken(String(token)));
  return { ok: info.changes > 0 };
}

/* ───────────────────────────── 头衔管理 ───────────────────────────── */

function listTitles() {
  const titles = db.prepare(
    "SELECT id, name, color, min_level, auto, sort, created_at FROM user_titles ORDER BY sort ASC, min_level ASC, id ASC"
  ).all();
  const counts = db.prepare(
    "SELECT title_id, COUNT(*) AS n FROM users WHERE title_id IS NOT NULL GROUP BY title_id"
  ).all();
  const map = new Map(counts.map((c) => [c.title_id, c.n]));
  return titles.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color || "",
    minLevel: t.min_level,
    auto: Boolean(t.auto),
    sort: t.sort,
    userCount: map.get(t.id) || 0,
    createdAt: t.created_at
  }));
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function createTitle({ name, color = "", minLevel = 1, auto = false, sort = 0 }) {
  const clean = String(name || "").trim().slice(0, 12);
  if (clean.length < 1) return { ok: false, error: "invalid_name" };
  if (color && !COLOR_RE.test(color)) return { ok: false, error: "invalid_color" };
  const exists = db.prepare("SELECT id FROM user_titles WHERE name = ?").get(clean);
  if (exists) return { ok: false, error: "duplicate_name" };
  const info = db.prepare(
    "INSERT INTO user_titles (name, color, min_level, auto, sort, created_at) VALUES (?,?,?,?,?,?)"
  ).run(clean, color || "", Math.max(1, Math.min(MAX_LEVEL, Number(minLevel) || 1)), auto ? 1 : 0, Number(sort) || 0, Date.now());
  bumpTitles();
  return { ok: true, id: info.lastInsertRowid };
}

function updateTitle(id, patch) {
  const row = db.prepare("SELECT id, name, color, min_level, auto, sort FROM user_titles WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };

  const sets = [];
  const args = [];

  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    const clean = String(patch.name || "").trim().slice(0, 12);
    if (!clean) return { ok: false, error: "invalid_name" };
    const dup = db.prepare("SELECT id FROM user_titles WHERE name = ? AND id <> ?").get(clean, row.id);
    if (dup) return { ok: false, error: "duplicate_name" };
    sets.push("name = ?");
    args.push(clean);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "color")) {
    const color = String(patch.color || "");
    if (color && !COLOR_RE.test(color)) return { ok: false, error: "invalid_color" };
    sets.push("color = ?");
    args.push(color);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "minLevel")) {
    sets.push("min_level = ?");
    args.push(Math.max(1, Math.min(MAX_LEVEL, Number(patch.minLevel) || 1)));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "auto")) {
    sets.push("auto = ?");
    args.push(patch.auto ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sort")) {
    sets.push("sort = ?");
    args.push(Number(patch.sort) || 0);
  }
  if (!sets.length) return { ok: true, unchanged: true };

  args.push(row.id);
  db.prepare(`UPDATE user_titles SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  bumpTitles();
  return { ok: true };
}

function deleteTitle(id) {
  const row = db.prepare("SELECT id FROM user_titles WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };
  db.transaction(() => {
    db.prepare("UPDATE users SET title_id = NULL WHERE title_id = ?").run(row.id);
    db.prepare("DELETE FROM user_titles WHERE id = ?").run(row.id);
  })();
  bumpTitles();
  return { ok: true };
}

/* ───────────────────────────── 管理动作 ───────────────────────────── */

function setUserStatus(userId, status) {
  if (!["active", "muted", "banned"].includes(status)) return { ok: false, error: "invalid_status" };
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  if (status === "banned") destroyUserSessions(userId); // 封禁立即踢下线
  return { ok: true };
}

function setUserTitle(userId, titleId) {
  if (titleId == null || titleId === "") {
    db.prepare("UPDATE users SET title_id = NULL WHERE id = ?").run(userId);
    return { ok: true };
  }
  const row = db.prepare("SELECT id FROM user_titles WHERE id = ?").get(Number(titleId) || 0);
  if (!row) return { ok: false, error: "title_not_found" };
  db.prepare("UPDATE users SET title_id = ? WHERE id = ?").run(row.id, userId);
  return { ok: true };
}

function setUserLevel(userId, level) {
  const n = Math.max(1, Math.min(MAX_LEVEL, Number(level) || 1));
  db.prepare("UPDATE users SET level = ?, exp = ? WHERE id = ?").run(n, expForLevel(n), userId);
  return { ok: true };
}

function setUserExp(userId, exp) {
  const e = Math.max(0, Math.floor(Number(exp) || 0));
  db.prepare("UPDATE users SET exp = ?, level = ? WHERE id = ?").run(e, levelFromExp(e), userId);
  return { ok: true };
}

function renameUser(userId, nickname) {
  const clean = String(nickname || "").trim();
  if (clean.length < NICKNAME_MIN || clean.length > NICKNAME_MAX) return { ok: false, error: "nickname_length" };
  db.prepare("UPDATE users SET nickname = ?, last_nickname_at = ?, nickname_flagged = NULL WHERE id = ?")
    .run(clean, Date.now(), userId);
  return { ok: true };
}

/** 昵称预审命中后由管理员确认放行（或由用户改名后自动清空） */
function clearNicknameFlag(userId) {
  db.prepare("UPDATE users SET nickname_flagged = NULL WHERE id = ?").run(userId);
  return { ok: true };
}

function setNicknameFlag(userId, flags) {
  db.prepare("UPDATE users SET nickname_flagged = ? WHERE id = ?").run(flags || null, userId);
  return { ok: true };
}

/** 后台用户列表：支持昵称/邮箱/学校/uuid 模糊搜索 */
function listUsers({ q = "", status = "", cursor = 0, limit = 30 } = {}) {
  const where = [];
  const args = [];

  if (q) {
    where.push("(nickname LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR school LIKE ? ESCAPE '\\' OR uuid LIKE ? ESCAPE '\\')");
    const like = "%" + String(q).replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    args.push(like, like, like, like);
  }
  if (status && ["active", "muted", "banned"].includes(status)) {
    where.push("status = ?");
    args.push(status);
  }
  const lastId = Number(cursor) || 0;
  if (lastId > 0) {
    where.push("id < ?");
    args.push(lastId);
  }

  const rows = db.prepare(
    `SELECT ${USER_COLUMNS} FROM users
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY id DESC LIMIT ?`
  ).all(...args, Math.min(100, Math.max(1, limit)) + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => adminUser(r)),
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null
  };
}

/** 昵称唯一性检查（不强制唯一，但给用户一个提示；真正的唯一键是 uuid） */
function nicknameTaken(nickname, exceptId = 0) {
  const row = db.prepare("SELECT id FROM users WHERE nickname = ? AND id <> ? LIMIT 1").get(String(nickname).trim(), exceptId);
  return Boolean(row);
}

module.exports = {
  AVATARS,
  EXP,
  MAX_LEVEL,
  NICKNAME_MIN,
  NICKNAME_MAX,
  BIO_MAX,
  configure,
  expForLevel,
  levelFromExp,
  makeUuid,
  normalizeEmail,
  isValidEmail,
  normalizeSchool,
  isValidSchool,
  schoolList,
  loadSchools,
  bumpSchools,
  listSchoolsAdmin,
  createSchool,
  updateSchool,
  deleteSchool,
  createUser,
  findByEmail,
  findByUuid,
  findById,
  publicUser,
  adminUser,
  rowsByIds,
  isActive,
  touchLogin,
  touchSeen,
  addExp,
  updateProfile,
  statsFor,
  nicknameTaken,
  createSession,
  userForToken,
  destroySession,
  destroyUserSessions,
  pruneSessions,
  tokenFromCookie,
  sessionCookie,
  clearSessionCookie,
  issueCode,
  verifyCode,
  lastCodeAt,
  codesInLastHour,
  issueRegisterToken,
  peekRegisterToken,
  consumeRegisterToken,
  listTitles,
  createTitle,
  updateTitle,
  deleteTitle,
  allTitles,
  bumpTitles,
  titleFor,
  setUserStatus,
  setUserTitle,
  setUserLevel,
  setUserExp,
  renameUser,
  clearNicknameFlag,
  setNicknameFlag,
  listUsers
};
