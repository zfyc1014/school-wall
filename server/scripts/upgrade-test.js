"use strict";

/**
 * 旧库升级测试（v1.0.0）。
 *
 * 为什么单独有这一个套件：其它测试全都用**全新库**，而真实部署是「旧库 + 新代码」——
 * 这条路径曾经在生产上炸过：schema.sql 里有
 *   CREATE INDEX ... ON posts(user_id, id DESC)
 * 而旧库的 posts 表已经存在（CREATE TABLE IF NOT EXISTS 是空操作），
 * 于是启动直接 SqliteError: no such column: user_id，服务反复重启。
 *
 * 本测试做的事：造一个 0.9 内测版形态的库（含旧数据）→ 用新代码启动 →
 * 断言「能起来」+「数据没丢」+「结构已升级」。
 *
 * 用法：node scripts/upgrade-test.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8500 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN = "upgrade-admin-token-0123456789abcdef";
const IP_SECRET = "upgrade-ip-hash-secret-0123456789abcdef";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-upgrade-"));
const DB_PATH = path.join(TMP, "legacy.db");

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failed += 1; failures.push(name); console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail))); }
};
const eq = (name, a, b) => ok(name, a === b, { actual: a, expected: b });

/* ── 1. 造一个「内测版 0.9」形态的库 ─────────────────────────────────── */

function buildLegacyDb() {
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);

  db.exec(`
    -- 0.9 的 posts：没有 user_id
    CREATE TABLE posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cat           TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      like_count    INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      flag          TEXT,
      ip_hash       TEXT,
      ua_hash       TEXT,
      created_at    INTEGER NOT NULL,
      reviewed_at   INTEGER
    );
    CREATE INDEX idx_posts_feed ON posts(status, created_at, id);

    -- 0.9 的 comments：没有 user_id
    CREATE TABLE comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL,
      body       TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'pending',
      flag       TEXT,
      ip_hash    TEXT,
      created_at INTEGER NOT NULL
    );

    -- 0.9 的 likes：主键是 ip_hash（新版本改名为 actor）
    CREATE TABLE likes (
      post_id    INTEGER NOT NULL,
      ip_hash    TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, ip_hash)
    ) WITHOUT ROWID;

    -- 0.9 的 reports：没有 reporter_id
    CREATE TABLE reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     INTEGER NOT NULL,
      comment_id  INTEGER,
      reason      TEXT,
      status      TEXT    NOT NULL DEFAULT 'open',
      ip_hash     TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX idx_reports_status ON reports(status, id DESC);

    -- 0.9 的 feedback：没有 user_id
    CREATE TABLE feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cat         TEXT    NOT NULL DEFAULT 'other',
      body        TEXT    NOT NULL,
      contact     TEXT,
      status      TEXT    NOT NULL DEFAULT 'open',
      ip_hash     TEXT,
      ua_hash     TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX idx_feedback_status ON feedback(status, id DESC);

    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT    NOT NULL,
      target     TEXT,
      note       TEXT,
      ip_hash    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_audit_time ON audit_log(created_at DESC);

    CREATE TABLE stats (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- 更早的实名时代遗留（v1.0.0 应当清掉）
    CREATE TABLE identities (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT);
    CREATE TABLE identity_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT);
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO posts (cat, body, status, like_count, comment_count, ip_hash, ua_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run("表白", "这是内测版留下的一条表白，升级后不能丢", "approved", 1, 1, "oldiphash", "olduahash", now - 86400000);

  db.prepare("INSERT INTO comments (post_id, body, status, ip_hash, created_at) VALUES (?,?,?,?,?)")
    .run(1, "内测版留下的评论", "approved", "oldiphash", now - 80000000);

  db.prepare("INSERT INTO likes (post_id, ip_hash, created_at) VALUES (?,?,?)")
    .run(1, "oldiphash", now - 70000000);

  db.prepare("INSERT INTO feedback (cat, body, status, created_at) VALUES (?,?,?,?)")
    .run("idea", "内测版留下的反馈", "open", now - 60000000);

  db.prepare("INSERT INTO stats (key, value, updated_at) VALUES (?,?,?)")
    .run("clean_shutdown", "clean", now - 50000000);

  db.close();
}

/* ── 2. 用新代码启动 ─────────────────────────────────────────────────── */

const server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    OD_SKIP_ENV_FILE: "1",
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DB_PATH,
    OUTBOX_DIR: path.join(TMP, "outbox"),
    ADMIN_TOKEN,
    IP_HASH_SECRET: IP_SECRET,
    AUTH_CODE_ECHO: "1",
    FORCE_HTTPS: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
let exited = null;
server.stdout.on("data", (c) => { serverLog += String(c); });
server.stderr.on("data", (c) => { serverLog += String(c); });
server.on("exit", (code) => { exited = code; });

function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error("进程提前退出（退出码 " + exited + "）\n" + serverLog);
    try {
      if ((await fetch(BASE + "/api/health")).ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("旧库升级后服务未能启动\n" + serverLog);
}

(async function main() {
  buildLegacyDb();
  console.log("旧库升级测试（0.9 形态的库 → v1.0.0）\n");

  await waitForServer();
  ok("服务能用旧库正常启动（本次修复的核心）", true);
  ok("启动日志里能看到补列迁移", /增加列 user_id/.test(serverLog), serverLog.split("\n").filter((l) => l.includes("迁移")));

  const feed = await (await fetch(BASE + "/api/posts")).json();
  eq("旧帖子还在（数据没丢）", feed.items.length, 1);
  ok("旧帖子正文完整", String(feed.items[0].body).includes("内测版留下的一条表白"));
  eq("旧帖子的点赞数没丢", feed.items[0].likes, 1);
  eq("旧帖子的评论数没丢", feed.items[0].comments, 1);

  const comments = await (await fetch(BASE + "/api/posts/1/comments")).json();
  eq("旧评论还在", comments.items.length, 1);

  const health = await (await fetch(BASE + "/api/health")).json();
  eq("新版本号已生效", health.version, "1.0.1");

  const stats = await (await fetch(BASE + "/api/admin/stats", { headers: { authorization: "Bearer " + ADMIN_TOKEN } })).json();
  eq("旧的未处理反馈仍可统计", stats.openFeedback, 1);
  ok("新表（用户/论坛/私信）已按需建立", stats.db.counts.users === 0 && stats.db.counts.threads === 0);

  // 直接看结构：升级后的列与历史清理
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true });
  const cols = (t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((c) => c.name);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();

  ok("posts.user_id 已补上", cols("posts").includes("user_id"), cols("posts"));
  ok("comments.user_id 已补上", cols("comments").includes("user_id"), cols("comments"));
  ok("reports.reporter_id 已补上", cols("reports").includes("reporter_id"));
  ok("feedback.user_id 已补上", cols("feedback").includes("user_id"));
  ok("likes.ip_hash 已改名为 actor", cols("likes").includes("actor") && !cols("likes").includes("ip_hash"), cols("likes"));
  // 旧的点赞行保留原值（老格式是裸哈希，新格式是 u:<uuid> / ip:<hash>，两者不会撞车），
  // 这样「谁已经点过赞」的状态不会因为升级而丢失。
  eq("旧的点赞行被完整保留", db.prepare("SELECT COUNT(*) FROM likes").pluck().get(), 1);
  ok("旧点赞主体保留原值且非空", Boolean(db.prepare("SELECT actor FROM likes").pluck().get()));
  ok("新表已建立（users/forum/社交）",
    ["users", "sessions", "auth_codes", "forum_threads", "forum_replies", "friendships", "dm_messages", "schools", "announcements", "user_titles"]
      .every((t) => tables.includes(t)));
  ok("实名时代的遗留表已清理", !tables.includes("identities") && !tables.includes("identity_codes"));
  ok("新索引已建立", db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_user'").get() !== undefined);
  db.close();

  // 再启动一次：幂等性（重复迁移不能报错、不能重复改）
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  const second = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env, OD_SKIP_ENV_FILE: "1", NODE_ENV: "test", HOST: "127.0.0.1",
      PORT: String(PORT), DB_PATH, ADMIN_TOKEN, IP_HASH_SECRET: IP_SECRET, AUTH_CODE_ECHO: "1", FORCE_HTTPS: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let secondLog = "";
  second.stderr.on("data", (c) => { secondLog += String(c); });
  let secondUp = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + "/api/health")).ok) { secondUp = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  ok("第二次启动（重复迁移）依然正常", secondUp, secondLog);
  try { second.kill(); } catch { /* ignore */ }

  /* ── 3. v1.0 形态的库（users.email NOT NULL）→ 迁移为可空 ───────── */
  // 这条路径最危险：整表重建。所以单独用一个 v1.0 形态的库验证数据与约束都留住了。
  console.log("\nusers.email 可空迁移（老库整表重建）");
  const legacy2 = path.join(TMP, "v10.db");
  {
    const Database = require("better-sqlite3");
    const d = new Database(legacy2);
    d.exec(`
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid       TEXT    NOT NULL UNIQUE,
        email      TEXT    NOT NULL UNIQUE,
        nickname   TEXT    NOT NULL,
        school     TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_users_created ON users(created_at DESC, id DESC);
      CREATE TABLE sessions (
        token_hash   TEXT    PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO users (uuid, email, nickname, school, created_at)
        VALUES ('legacy-uuid-1', 'old@example.com', '老用户', '旧大学', 1700000000000);
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
        VALUES ('legacy-session', 1, 1700000000000, 1900000000000, 1700000000000);
    `);
    d.close();
  }

  const legacyPort = PORT + 1;
  const legacyApp = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env, OD_SKIP_ENV_FILE: "1", NODE_ENV: "test", HOST: "127.0.0.1",
      PORT: String(legacyPort), DB_PATH: legacy2, ADMIN_TOKEN, IP_HASH_SECRET: IP_SECRET,
      AUTH_CODE_ECHO: "1", FORCE_HTTPS: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let legacyLog = "";
  legacyApp.stderr.on("data", (c) => { legacyLog += String(c); });
  let legacyUp = false;
  {
    const deadline2 = Date.now() + 15000;
    while (Date.now() < deadline2) {
      try {
        if ((await fetch("http://127.0.0.1:" + legacyPort + "/api/health")).ok) { legacyUp = true; break; }
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  ok("v1.0 库迁移后服务能启动", legacyUp, legacyLog.split("\n").slice(-8).join(" | "));
  try { legacyApp.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300));

  {
    const Database = require("better-sqlite3");
    const d = new Database(legacy2);
    const emailCol = d.prepare("PRAGMA table_info(users)").all().find((c) => c.name === "email");
    ok("users.email 已变为可空", Boolean(emailCol) && emailCol.notnull === 0, emailCol);
    const legacyRow = d.prepare("SELECT uuid, nickname, school, phone FROM users WHERE uuid = 'legacy-uuid-1'").get();
    ok("老用户数据完整保留", Boolean(legacyRow && legacyRow.nickname === "老用户" && legacyRow.school === "旧大学"), legacyRow);
    const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_users_created','idx_users_phone')")
      .pluck().all();
    ok("users 的索引在重建后重新建好", idx.includes("idx_users_created") && idx.includes("idx_users_phone"), idx);
    eq("老会话没有被破坏（外键仍指向 users）",
      d.prepare("PRAGMA foreign_key_check").all().length, 0);
    eq("sessions 里的老会话还在", d.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 1);
    // CHECK 约束：不能出现「既没邮箱也没手机号」的账号
    let checkFailed = false;
    try {
      d.prepare("INSERT INTO users (uuid, nickname, school, created_at) VALUES ('bad-uuid','无身份','某校',?)")
        .run(Date.now());
    } catch { checkFailed = true; }
    ok("CHECK 约束拒绝「无邮箱也无手机号」的账号", checkFailed);
    // 手机号注册形态可以写入
    let phoneInserted = false;
    try {
      d.prepare("INSERT INTO users (uuid, phone, phone_verified_at, nickname, school, created_at) VALUES ('p-uuid-1','+8613711112222',?,?,?,?)")
        .run(Date.now(), "手机用户", "旧大学", Date.now());
      phoneInserted = true;
    } catch { phoneInserted = false; }
    ok("可以插入只有手机号的账号（自选注册的前提）", phoneInserted);
    d.close();
  }

  console.log("\n=== 通过 " + passed + " / 失败 " + failed + " ===");
  if (failed) {
    console.log("失败项：" + failures.join("、"));
    console.log(serverLog.split("\n").slice(-25).join("\n"));
  }
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("升级测试崩溃：" + ((err && err.stack) || err));
  console.log(serverLog.split("\n").slice(-30).join("\n"));
  cleanup();
  process.exit(1);
});
