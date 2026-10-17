"use strict";

/**
 * 数据库体检（v1.0.0）。
 *
 * 定位：**上线前后都能跑的自检**，回答三个问题 ——
 *   1. 结构对不对（表、索引是不是齐了）；
 *   2. 计数对不对（缓存列和明细表是否一致，这类不一致只会越滚越大）；
 *   3. 文件健不健康（完整性、外键、可回收空间、WAL 大小）。
 *
 * 用法：
 *   node scripts/db-check.js                体检默认库（server/data/wall.db）
 *   node scripts/db-check.js --db=<path>    体检指定库
 *   node scripts/db-check.js --recount      全量校准 posts.like_count 后退出
 *
 * 注意：本脚本会 require src/db.js —— 这样才能复用同一套连接参数，
 * 并且**在结束时写回「干净退出」标记**（否则下次启动会误判为非优雅退出而做全量校准）。
 */

const path = require("path");

/**
 * 子进程模式：把所有输出**同步**追加到一个文件里。
 *
 * 为什么不能只依赖 stdout：实测 Node 24 + better-sqlite3 在 Windows 上，
 * 只要进程里加载过原生模块，退出阶段就偶发撞
 *   Assertion failed: (env) != nullptr   → SIGABRT(134)
 * 而且 process.exit() 时**缓冲区里的 stdout 会整块丢失**（连已经 console.log 过的内容都没了）。
 * appendFileSync 是直接的系统调用，写下去就一定在。
 */
const LOG_FILE = process.env.DB_CHECK_CHILD === "1" ? process.env.DB_CHECK_LOG_FILE : "";
if (LOG_FILE) {
  const fsSync = require("fs");
  try { fsSync.writeFileSync(LOG_FILE, ""); } catch { /* ignore */ }
  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...parts) => {
      const line = parts.map((p) => String(p)).join(" ") + "\n";
      try { fsSync.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
      original(...parts);
    };
  }
}

const args = process.argv.slice(2);
const recountOnly = args.includes("--recount");
const dbArg = args.find((a) => a.startsWith("--db="));
if (dbArg) process.env.DB_PATH = dbArg.slice(5);

/*
 * ── 父进程：只负责调度与判定 ────────────────────────────────────────────
 *
 * 必须在 require("../src/db") **之前**：父进程一旦加载了 better-sqlite3，
 * 它自己也会在退出阶段撞上那个原生断言，包装就白做了。
 */
if (process.env.DB_CHECK_CHILD !== "1") {
  const { spawnSync } = require("child_process");
  const fsMod = require("fs");
  const osMod = require("os");

  const logFile = path.join(osMod.tmpdir(), "wall-dbcheck-" + process.pid + ".log");
  const verdictFile = logFile + ".verdict";
  try { fsMod.unlinkSync(logFile); } catch { /* 不存在就算了 */ }
  try { fsMod.unlinkSync(verdictFile); } catch { /* 不存在就算了 */ }

  const child = spawnSync(process.execPath, [__filename].concat(process.argv.slice(2)), {
    env: Object.assign({}, process.env, {
      DB_CHECK_CHILD: "1",
      DB_CHECK_LOG_FILE: logFile,
      DB_CHECK_VERDICT_FILE: verdictFile
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  // 日志与结论都以「子进程自己写的文件」为准；管道只做兜底
  let out = "";
  try { out = fsMod.readFileSync(logFile, "utf8"); } catch { /* 没写出来 */ }
  if (!out) out = (child.stdout || "") + (child.stderr || "");
  let verdictText = "";
  try { verdictText = fsMod.readFileSync(verdictFile, "utf8"); } catch { /* 没写出来 */ }
  try { fsMod.unlinkSync(logFile); } catch { /* ignore */ }
  try { fsMod.unlinkSync(verdictFile); } catch { /* ignore */ }

  process.stdout.write(out);

  const verdict = /__VERDICT__ (ok|fail:([0-9]+))/.exec(verdictText || out);
  // 兜底：只要输出里能看见结论文字，就按结论判定 —— 进程怎么死的与体检结果无关
  let ok = verdict ? verdict[1] === "ok" : null;
  if (ok === null) {
    if (/===\s*全部通过\s*===/.test(out)) ok = true;
    else if (/===\s*有 \d+ 项异常/.test(out)) ok = false;
  }

  if (ok === null) {
    console.error("[db-check] 没能拿到体检结论（子进程退出码 " + child.status + "，signal " + child.signal + "）");
    process.exit(1);
  }
  if (child.status === 134 || child.signal === "SIGABRT") {
    console.log("[db-check] 注：子进程在退出阶段触发了 better-sqlite3 的原生断言（SIGABRT）；结论已在上方，与体检结果无关。");
  }
  process.exit(ok ? 0 : 1);
}

const db = require("../src/db");

let failed = 0;
const problems = [];

function check(name, condition, detail) {
  if (condition) {
    console.log("  ✓ " + name);
  } else {
    failed += 1;
    problems.push(name);
    console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail)));
  }
}

const one = (sql, ...params) => db.prepare(sql).pluck().get(...params);
const tableExists = (name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/* ───────────────────────────── 结构 ───────────────────────────── */

const EXPECTED_TABLES = [
  "users", "auth_codes", "sessions", "register_tokens",
  "user_titles", "schools", "announcements",
  "posts", "comments", "likes", "reports", "feedback", "audit_log", "stats",
  "forum_threads", "forum_replies", "thread_likes",
  "friendships", "dm_messages",
  "afdian_orders"
];

/**
 * 期望存在的索引。写死清单是有意的：
 * 每个索引都要有真实的查询在用它（见 schema.sql 的说明），
 * 少一个会让某个热查询变成全表扫描，多一个则是纯粹的写入放大。
 */
const EXPECTED_INDEXES = [
  // users(phone) 是**唯一**索引（部分索引：NULL 不算重复）：手机号登录靠它查人，
  // 同时保证一个号码只能绑一个账号
  "idx_users_created", "idx_users_phone", "idx_auth_codes_lookup", "idx_sessions_user", "idx_sessions_expiry",
  "idx_schools_active", "idx_announcements_active",
  "idx_posts_feed", "idx_posts_hot", "idx_posts_cat", "idx_posts_user",
  "idx_comments_post", "idx_comments_queue", "idx_comments_user",
  "idx_reports_status", "idx_reports_post", "idx_feedback_status", "idx_audit_time",
  "idx_threads_board", "idx_threads_new", "idx_threads_hot", "idx_threads_author",
  "idx_replies_thread", "idx_replies_author", "idx_friendships_addressee",
  "idx_dm_pair", "idx_dm_inbox",
  "idx_afdian_user", "idx_afdian_received", "idx_afdian_unbound"
];

function checkSchema() {
  console.log("\n结构");
  const missingTables = EXPECTED_TABLES.filter((name) => !tableExists(name));
  check("表齐全（" + EXPECTED_TABLES.length + " 张）", missingTables.length === 0, missingTables);

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
    .pluck().all();
  const missingIdx = EXPECTED_INDEXES.filter((name) => !indexes.includes(name));
  const extraIdx = indexes.filter((name) => !EXPECTED_INDEXES.includes(name));
  check("索引齐全（" + EXPECTED_INDEXES.length + " 条）", missingIdx.length === 0, missingIdx);
  check("没有多余的索引（写入放大）", extraIdx.length === 0, extraIdx);

  // UNIQUE 约束会自动建索引：users.email、users.uuid、user_titles.name、schools.name、
  // afdian_orders.out_trade_no（幂等发奖就靠它）。
  // WITHOUT ROWID 的表把主键当聚簇键，不会额外生成 sqlite_autoindex_*
  const autoIdx = db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'sqlite_autoindex_%'"
  ).pluck().get();
  check("唯一约束自带索引存在（邮箱 / uuid / 头衔名 / 校名 / 订单号）", autoIdx === 5, { autoIdx });

  check("已删除实名时代的遗留表",
    !tableExists("identities") && !tableExists("identity_codes"));
}

/* ───────────────────────────── 健康 ───────────────────────────── */

function checkHealth() {
  console.log("\n文件健康");
  check("PRAGMA integrity_check", one("PRAGMA integrity_check") === "ok");

  const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
  check("外键约束无违规", fkViolations.length === 0, fkViolations.slice(0, 3));

  const journalMode = one("PRAGMA journal_mode");
  check("WAL 模式（单写多读不互相阻塞）", journalMode === "wal", journalMode);

  const quick = db.pragma("quick_check");
  check("quick_check", quick[0] && quick[0].quick_check === "ok", quick);
}

/* ───────────────────────────── 计数一致性 ───────────────────────────── */

function checkCounts() {
  console.log("\n计数一致性（缓存列 vs 明细表）");

  const likeMismatch = one(
    `SELECT COUNT(*) FROM posts
      WHERE like_count <> (SELECT COUNT(*) FROM likes WHERE post_id = posts.id)`
  );
  check("posts.like_count 与 likes 表一致", likeMismatch === 0, { rows: likeMismatch });

  const commentMismatch = one(
    `SELECT COUNT(*) FROM posts
      WHERE comment_count <> (SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND status = 'approved')`
  );
  check("posts.comment_count 只统计已通过的评论", commentMismatch === 0, { rows: commentMismatch });

  const replyMismatch = one(
    `SELECT COUNT(*) FROM forum_threads
      WHERE reply_count <> (SELECT COUNT(*) FROM forum_replies WHERE thread_id = forum_threads.id AND status = 'approved')`
  );
  check("forum_threads.reply_count 一致", replyMismatch === 0, { rows: replyMismatch });

  const threadLikeMismatch = one(
    `SELECT COUNT(*) FROM forum_threads
      WHERE like_count <> (SELECT COUNT(*) FROM thread_likes WHERE thread_id = forum_threads.id)`
  );
  check("forum_threads.like_count 一致", threadLikeMismatch === 0, { rows: threadLikeMismatch });

  const orphanLikes = one("SELECT COUNT(*) FROM likes WHERE post_id NOT IN (SELECT id FROM posts)");
  check("没有孤儿点赞", orphanLikes === 0, { rows: orphanLikes });

  const orphanComments = one("SELECT COUNT(*) FROM comments WHERE post_id NOT IN (SELECT id FROM posts)");
  check("没有孤儿评论", orphanComments === 0, { rows: orphanComments });

  const badLevel = one(
    "SELECT COUNT(*) FROM users WHERE level < 1 OR level > 99 OR exp < 0"
  );
  check("用户等级/经验在合法区间", badLevel === 0, { rows: badLevel });

  const selfFriends = one("SELECT COUNT(*) FROM friendships WHERE requester_id = addressee_id");
  check("没有「自己是自己的好友」", selfFriends === 0, { rows: selfFriends });

  const selfDm = one("SELECT COUNT(*) FROM dm_messages WHERE sender_id = recipient_id");
  check("没有发给自己私信", selfDm === 0, { rows: selfDm });

  const noSchool = one("SELECT COUNT(*) FROM users WHERE school IS NULL OR school = ''");
  check("所有用户都有学校（登录时强制选择）", noSchool === 0, { rows: noSchool });

  const dupUuid = one("SELECT COUNT(*) FROM (SELECT uuid FROM users GROUP BY uuid HAVING COUNT(*) > 1)");
  check("uuid 唯一", dupUuid === 0, { rows: dupUuid });

  const emptyNick = one("SELECT COUNT(*) FROM users WHERE nickname IS NULL OR nickname = ''");
  check("所有用户都有昵称", emptyNick === 0, { rows: emptyNick });
}

/* ───────────────────────────── 概览 ───────────────────────────── */

function report() {
  const stats = db.stats();
  const counts = stats.counts;
  console.log("\n概览");
  console.log(`  数据库        ${stats.path}`);
  console.log(`  文件大小      ${(stats.fileBytes / 1024 / 1024).toFixed(2)} MB（可回收 ${(stats.reclaimableBytes / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`  WAL           ${(stats.walBytes / 1024).toFixed(0)} KB`);
  console.log(`  页缓存        ${stats.cacheMb} MB`);
  console.log(`  用户 ${counts.users} ｜ 帖子 ${counts.posts}（已公开 ${counts.approved} / 待审 ${counts.pending}）`);
  console.log(`  主题 ${counts.threads} ｜ 回复 ${counts.replies} ｜ 私信 ${counts.messages} ｜ 会话 ${counts.sessions}`);
  console.log(`  评论 ${counts.comments} ｜ 点赞 ${counts.likes} ｜ 工单 ${counts.reports} ｜ 反馈 ${counts.feedback}`);
}

/* ───────────────────────────── 入口 ───────────────────────────── */

/**
 * 收尾：先写干净退出标记 → 回收语句对象 → 关连接 → 用 exitCode 让进程自然结束。
 *
 * 中间那步「回收语句对象」是必须的，不是洁癖：
 * better-sqlite3 的 Statement 析构函数会碰原生环境，如果它们拖到 V8 开始拆卸
 * 环境时才被 GC，就会撞上
 *   Assertion failed: (env) != nullptr   （RemoveEnvironmentCleanupHook → Statement 析构）
 * 进程以 SIGABRT(134) 结束 —— 实测本脚本曾以约一半概率如此（退出码在 0 与 134 之间跳），
 * 于是 npm run verify 会随机失败。手动 GC 让这些对象在环境健康时就析构掉。
 *
 * Node 默认不带 --expose-gc，用 v8.setFlagsFromString + 新上下文取回 gc；
 * 拿不到也退回自然退出（结果仍然正确，只是有概率再出现 134）。
 */
function finish(code) {
  try {
    db.shutdown();
  } catch { /* 关库失败也要给出退出码 */ }

  try {
    require("v8").setFlagsFromString("--expose-gc");
    require("vm").runInNewContext("gc")();
  } catch { /* 拿不到 gc 就跳过 */ }

  try { db.close(); } catch { /* ignore */ }

  // 判定行必须**同步写**：这个进程有可能在退出阶段被原生断言打断（SIGABRT），
  // 而 Node 对管道 stdout 是异步写 —— 异步写的内容会随进程一起消失，
  // 父进程就只看到「没有结论」。writeSync 保证它先落到管道里。
  const verdictLine = "__VERDICT__ " + (code ? "fail:" + failed : "ok") + "\n";
  try { if (LOG_FILE) require("fs").appendFileSync(LOG_FILE, verdictLine); } catch { /* ignore */ }
  // 写独立文件（父进程据此判定），同时照常打到 stdout 供人看
  try {
    const target = process.env.DB_CHECK_VERDICT_FILE;
    if (target) require("fs").writeFileSync(target, verdictLine, "utf8");
  } catch { /* 结论文件写不出来也不能让体检结果丢失 */ }
  try { require("fs").writeSync(1, verdictLine); } catch { /* 管道断了也要继续 */ }

  // 结论已经落地，直接退出；不再走「自然排空 → 拆卸环境」那条会偶发断言的路
  process.exit(code);
}

if (recountOnly) {
  const result = db.recountLikeCounts();
  console.log(`\n已全量校准点赞缓存：修正 ${result.changes} 行，耗时 ${result.ms}ms`);
  finish(0);
  return;
}

function main() {
  console.log(`数据库体检 · ${db.DB_PATH}`);
  checkSchema();
  checkHealth();
  checkCounts();
  report();

  if (failed) {
    console.log(`\n=== 有 ${failed} 项异常：${problems.join("、")} ===`);
    console.log("提示：点赞计数不一致可用 --recount 修复；索引缺失重启一次服务即可自动补建。");
  } else {
    console.log("\n=== 全部通过 ===");
  }
  finish(failed ? 1 : 0);
}

main();
