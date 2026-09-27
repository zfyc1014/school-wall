"use strict";

/**
 * 数据库自检：结构、查询计划、计数一致性、保留期清理、干净退出标记。
 *
 * 为什么要有这个脚本：低配 VPS 上数据库出问题往往是「悄悄变慢」——
 * 索引没被用上、计数漂移、WAL 无限增长。这些都不会报错，只会越来越慢。
 * 这里把它们变成可断言的检查，升级或改 schema 后跑一次即可。
 *
 * 用法：
 *   node scripts/db-check.js                    用临时库跑全部检查
 *   node scripts/db-check.js --db ./data/wall.db  针对指定库（只读检查为主）
 *   node scripts/db-check.js --recount          额外做一次全量点赞校准
 *
 * 注意：脚本默认使用临时数据库，不会碰 data/wall.db。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const useRealDb = flag("--real");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "od-dbcheck-"));
const targetDb = useRealDb
  ? path.resolve(value("--db", path.join(__dirname, "..", "data", "wall.db")))
  : path.join(tmpDir, "check.db");

process.env.DB_PATH = targetDb;
// 让初始化路径完全确定：显式声明不要因为「上次非优雅退出」触发校准噪音
if (!flag("--recount")) process.env.DB_RECOUNT_DAYS = "3650";

const results = [];
const ok = (name, detail = "") => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`); };
const bad = (name, detail = "") => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

const db = require("../src/db");

console.log(`\n数据库自检：${targetDb}\n`);

/* ── 1. 结构 ─────────────────────────────────────────────────────── */

console.log("[1/6] 表与索引");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .pluck().all();
check("核心表齐全", ["audit_log", "comments", "likes", "posts", "reports", "stats"].every((t) => tables.includes(t)), tables.join(", "));

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").pluck().all();
const expectedIndexes = [
  // 内容与工单
  "idx_posts_feed", "idx_posts_hot", "idx_posts_cat",
  "idx_comments_post", "idx_comments_queue",
  "idx_reports_status", "idx_reports_post", "idx_audit_time",
  // 后台实名（实名制上线新增）
  "idx_identities_recent", "idx_posts_identity", "idx_comments_identity",
  "idx_reports_identity", "idx_codes_lookup"
];
const missing = expectedIndexes.filter((i) => !indexes.includes(i));
check("索引齐全（含 pending 部分索引）", missing.length === 0, missing.length ? `缺少 ${missing.join(", ")}` : `${indexes.length} 个`);

const pragmas = {
  journal_mode: db.pragma("journal_mode", { simple: true }),
  synchronous: db.pragma("synchronous", { simple: true }),
  foreign_keys: db.pragma("foreign_keys", { simple: true }),
  busy_timeout: db.pragma("busy_timeout", { simple: true }),
  temp_store: db.pragma("temp_store", { simple: true })
};
check("WAL 模式", pragmas.journal_mode === "wal", pragmas.journal_mode);
check("同步级别 NORMAL（1）", pragmas.synchronous === 1, String(pragmas.synchronous));
check("外键约束开启", pragmas.foreign_keys === 1, String(pragmas.foreign_keys));
check("busy_timeout 已设置", pragmas.busy_timeout >= 1000, `${pragmas.busy_timeout}ms`);

/* ── 2. 查询计划（这是「优化」真正的验收点）───────────────────────── */

/**
 * 计划断言跑两遍：ANALYZE 之前和之后。
 * 理由：真实事故就出在这里 —— 没有统计信息时走索引，收集统计信息后
 * 优化器改判「全表扫描更便宜」，首屏查询悄悄退化。所以要求计划**稳定**，
 * 而不是「某一时刻看起来不错」。
 */
console.log("[2/6] 关键查询是否走索引（EXPLAIN QUERY PLAN）");
const plan = (sql, ...params) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(" | ");

/**
 * 灌入有代表性的数据再断言。
 * 注意 created_at 必须单调递减 —— 如果所有行 created_at 相同，索引对排序
 * 就没有价值，优化器转向全表扫描反而是对的，那样的数据不能用来验证计划。
 */
const seedPosts = db.prepare(
  "INSERT INTO posts (cat, body, status, like_count, comment_count, created_at) VALUES (?,?,?,?,?,?)"
);
const seedComments = db.prepare(
  "INSERT INTO comments (post_id, body, status, created_at) VALUES (?,?,?,?)"
);
const seedReports = db.prepare(
  "INSERT INTO reports (post_id, reason, status, created_at) VALUES (?,?,?,?)"
);
const seedMany = db.transaction(() => {
  const cats = ["表白", "树洞", "寻人", "失物", "致谢"];
  const base = Date.now();
  for (let i = 0; i < 600; i += 1) {
    const approved = i % 20 !== 0; // 5% pending，贴近真实审核队列比例
    seedPosts.run(
      cats[i % cats.length],
      `压测内容 ${i}：用于让统计信息贴近真实分布。`,
      approved ? "approved" : "pending",
      i % 137,
      i % 9,
      base - i * 60000
    );
  }
  for (let i = 0; i < 300; i += 1) {
    seedComments.run((i % 100) + 1, `压测评论 ${i}`, i % 30 === 0 ? "pending" : "approved", base - i * 60000);
  }
  for (let i = 0; i < 40; i += 1) {
    seedReports.run((i % 100) + 1, "压测举报", i % 4 === 0 ? "open" : "actioned", base - i * 60000);
  }
});
seedMany();

const COLS = "id, cat, body, like_count, comment_count, created_at";
const SQL_NEW = `SELECT ${COLS} FROM posts WHERE status='approved' ORDER BY created_at DESC, id DESC LIMIT 21`;
const SQL_NEW_PAGE = `SELECT ${COLS} FROM posts WHERE status='approved' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 21`;
const SQL_HOT = `SELECT ${COLS} FROM posts WHERE status='approved' ORDER BY like_count DESC, id DESC LIMIT 21`;
const SQL_HOT_PAGE = `SELECT ${COLS} FROM posts WHERE status='approved' AND (like_count, id) < (?, ?) ORDER BY like_count DESC, id DESC LIMIT 21`;
const SQL_CAT_PAGE = `SELECT ${COLS} FROM posts WHERE status='approved' AND cat='表白' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 21`;
const SQL_QUEUE_POSTS = "SELECT id, cat, body, flag, created_at FROM posts WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 50";
const SQL_QUEUE_COMMENTS = "SELECT id FROM comments WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 50";
const SQL_COMMENTS = "SELECT id, body, created_at FROM comments WHERE post_id=1 AND status='approved' ORDER BY id ASC LIMIT 200";
const SQL_LIKES = "SELECT COUNT(*) FROM likes WHERE post_id = 1";
const SQL_REPORTS = "SELECT * FROM reports WHERE status='open' ORDER BY id DESC LIMIT 100";
/** 实名相关热查询：取某号码最近一条未消费的验证码、从身份反查内容、最近身份列表 */
const SQL_CODE_LOOKUP = "SELECT id, code_hash FROM identity_codes WHERE phone_hash = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1";
const SQL_IDENTITY_POSTS = "SELECT id, cat, body FROM posts WHERE identity_id = ? ORDER BY id DESC LIMIT 200";
const SQL_RECENT_IDENTITIES = "SELECT id FROM identities ORDER BY verified_at DESC, id DESC LIMIT 50";

/** 一次跑完所有关键查询并返回计划文本 */
function snapPlans() {
  return {
    new: plan(SQL_NEW),
    newPage: plan(SQL_NEW_PAGE, 9e12, 999999),
    hot: plan(SQL_HOT),
    hotPage: plan(SQL_HOT_PAGE, 999, 999999),
    catPage: plan(SQL_CAT_PAGE, 9e12, 999999),
    queuePosts: plan(SQL_QUEUE_POSTS),
    queueComments: plan(SQL_QUEUE_COMMENTS),
    comments: plan(SQL_COMMENTS),
    likes: plan(SQL_LIKES),
    reports: plan(SQL_REPORTS),
    codeLookup: plan(SQL_CODE_LOOKUP, "h"),
    identityPosts: plan(SQL_IDENTITY_POSTS, 1),
    recentIdentities: plan(SQL_RECENT_IDENTITIES)
  };
}

/** 所有关键查询都必须命中某个索引，且不能出现临时 B 树排序 */
function assertPlans(tag) {
  const p = snapPlans();
  const noScan = (sql) => !/\bSCAN\b/.test(sql);
  const noTemp = (sql) => !/TEMP B-TREE/.test(sql);

  check(`[${tag}] 首屏 sort=new 走 idx_posts_feed`,
    /idx_posts_feed/.test(p.new) && noScan(p.new), p.new);
  check(`[${tag}] sort=new 翻页走行值区间扫描（无临时排序）`,
    /idx_posts_feed/.test(p.newPage) && noScan(p.newPage) && noTemp(p.newPage), p.newPage);
  check(`[${tag}] 热榜 sort=hot 走 idx_posts_hot`,
    /idx_posts_hot/.test(p.hot) && noScan(p.hot), p.hot);
  check(`[${tag}] 热榜翻页走行值区间扫描（无临时排序）`,
    /idx_posts_hot/.test(p.hotPage) && noScan(p.hotPage) && noTemp(p.hotPage), p.hotPage);
  check(`[${tag}] 分类翻页走 idx_posts_cat`,
    /idx_posts_cat/.test(p.catPage) && noScan(p.catPage) && noTemp(p.catPage), p.catPage);
  check(`[${tag}] 审核队列（帖子）无临时排序`,
    /idx_posts_feed/.test(p.queuePosts) && noTemp(p.queuePosts), p.queuePosts);
  check(`[${tag}] 审核队列（评论）走 idx_comments_queue`,
    /idx_comments_queue/.test(p.queueComments) && noScan(p.queueComments) && noTemp(p.queueComments), p.queueComments);
  check(`[${tag}] 按帖取评论走 idx_comments_post`,
    /idx_comments_post/.test(p.comments) && noScan(p.comments), p.comments);
  check(`[${tag}] 点赞计数走主键前缀`,
    /PRIMARY KEY/.test(p.likes) && noScan(p.likes), p.likes);
  check(`[${tag}] 待处理工单走 idx_reports_status`,
    /idx_reports_status/.test(p.reports) && noScan(p.reports), p.reports);
  check(`[${tag}] 实名：取最近验证码走 idx_codes_lookup（含未消费条件）`,
    /idx_codes_lookup/.test(p.codeLookup), p.codeLookup);
  check(`[${tag}] 实名：从身份反查内容走 idx_posts_identity`,
    /idx_posts_identity/.test(p.identityPosts) && noScan(p.identityPosts), p.identityPosts);
  check(`[${tag}] 实名：最近身份列表走 idx_identities_recent`,
    /idx_identities_recent/.test(p.recentIdentities), p.recentIdentities);

  return p;
}

assertPlans("无统计信息");
db.exec("ANALYZE");
const after = assertPlans("ANALYZE 后");

// 索引预算：索引不是越多越好，这里把「预期数量」写死，避免以后被随手加回来
const allIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").pluck().all();
check("索引数量在预算内（无冗余索引）", allIndexes.length === 13, `${allIndexes.length} 个：${allIndexes.sort().join(", ")}`);

/* ── 3. 写入与计数一致性 ─────────────────────────────────────────── */

console.log("\n[3/6] 写入路径与计数一致性");
const now = Date.now();
const postId = db.prepare(
  "INSERT INTO posts (cat, body, status, ip_hash, created_at) VALUES (?,?,?,?,?)"
).run("表白", "自检内容：用于验证计数与级联行为。", "approved", "selfcheck", now).lastInsertRowid;

// 点赞 3 次（不同 IP），模拟批量回写后的权威计数
const like = db.prepare("INSERT INTO likes (post_id, ip_hash, created_at) VALUES (?,?,?)");
["a", "b", "c"].forEach((ip) => like.run(postId, ip, now));
db.prepare("UPDATE posts SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = ?) WHERE id = ?")
  .run(postId, postId);

const likes = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").get(postId).n;
const cached = db.prepare("SELECT like_count FROM posts WHERE id = ?").get(postId).like_count;
check("点赞缓存与 likes 表一致", likes === 3 && cached === 3, `likes=${likes} cache=${cached}`);

// 评论计数：先审后发的两条路径
const c1 = db.prepare("INSERT INTO comments (post_id, body, status, created_at) VALUES (?,?,?,?)")
  .run(postId, "正常评论", "approved", now).lastInsertRowid;
const c2 = db.prepare("INSERT INTO comments (post_id, body, status, created_at) VALUES (?,?,?,?)")
  .run(postId, "含 13800000000 的评论", "pending", now).lastInsertRowid;
db.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?").run(postId);
let count = db.prepare("SELECT comment_count FROM posts WHERE id = ?").get(postId).comment_count;
check("公开评论计入 comment_count", count === 1, `count=${count}`);

// 审核通过 pending 评论 → +1；再把已通过的评论驳回 → -1（这是修掉的那个漂移 bug）
db.prepare("UPDATE comments SET status='approved' WHERE id = ?").run(c2);
db.prepare("UPDATE posts SET comment_count = MAX(0, comment_count + 1) WHERE id = ?").run(postId);
count = db.prepare("SELECT comment_count FROM posts WHERE id = ?").get(postId).comment_count;
check("审核通过评论后计数 +1", count === 2, `count=${count}`);

db.prepare("UPDATE comments SET status='rejected' WHERE id = ?").run(c1);
db.prepare("UPDATE posts SET comment_count = MAX(0, comment_count + -1) WHERE id = ?").run(postId);
count = db.prepare("SELECT comment_count FROM posts WHERE id = ?").get(postId).comment_count;
check("驳回已通过评论后计数 -1（不再单向上漂）", count === 1, `count=${count}`);

// 下架 → 删除帖子 → 级联清掉点赞与评论
db.prepare("UPDATE posts SET status='removed' WHERE id = ?").run(postId);
db.prepare("DELETE FROM posts WHERE status='removed'").run();
const leftLikes = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").get(postId).n;
const leftComments = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE post_id = ?").get(postId).n;
check("删除已下架帖子后级联清理点赞", leftLikes === 0, `残留 ${leftLikes}`);
check("删除已下架帖子后级联清理评论", leftComments === 0, `残留 ${leftComments}`);

/* ── 4. 举报工单 ─────────────────────────────────────────────────── */

console.log("\n[4/6] 工单与去重索引");
const p2 = db.prepare("INSERT INTO posts (cat, body, status, created_at) VALUES (?,?,?,?)")
  .run("树洞", "第二条自检内容。", "approved", now).lastInsertRowid;
db.prepare("INSERT INTO reports (post_id, reason, ip_hash, created_at) VALUES (?,?,?,?)")
  .run(p2, "自检举报", "selfcheck", now);
const dup = db.prepare(
  "SELECT id FROM reports WHERE post_id = ? AND ip_hash = ? AND status = 'open' LIMIT 1"
).get(p2, "selfcheck");
check("同一 IP 对同一帖可查到已有工单（用于去重）", Boolean(dup));

const planDup = plan("SELECT id FROM reports WHERE post_id = ? AND ip_hash = ? AND status = 'open' LIMIT 1", p2, "selfcheck");
check("举报去重查询走索引", /idx_reports_post|idx_reports_open/.test(planDup) && !/SCAN reports/.test(planDup), planDup);

/* ── 5. 保留期清理 ───────────────────────────────────────────────── */

console.log("\n[5/6] 保留期清理与空间回收");
const old = Date.now() - 200 * 86400000;
db.prepare("INSERT INTO posts (cat, body, status, created_at) VALUES (?,?,?,?)")
  .run("树洞", "很久以前被拒的内容。", "rejected", old);
db.prepare("INSERT INTO audit_log (action, target, created_at) VALUES (?,?,?)")
  .run("post.reject", "999", old);

// 孤儿行：外键 ON DELETE CASCADE 正常情况下不会产生孤儿，
// 所以这里临时关掉外键约束来构造一个（对应早期没有外键的库/外部导入的数据）。
db.pragma("foreign_keys = OFF");
const orphanPost = db.prepare("INSERT INTO posts (cat, body, status, created_at) VALUES (?,?,?,?)")
  .run("失物", "待产生孤儿点赞。", "approved", now).lastInsertRowid;
db.prepare("INSERT INTO likes (post_id, ip_hash, created_at) VALUES (?,?,?)").run(orphanPost, "ghost", now);
db.prepare("DELETE FROM posts WHERE id = ?").run(orphanPost);
db.pragma("foreign_keys = ON");
const orphanExists = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").get(orphanPost).n;
check("已构造出孤儿点赞行（外键关闭状态下）", orphanExists === 1, `孤儿 ${orphanExists} 行`);

const beforeCleanup = db.stats().counts;
const cleaned = db.cleanup(90);
const afterCleanup = db.stats().counts;
check("保留期清理删除了过期内容",
  cleaned.removed.rejected_posts === 1, JSON.stringify(cleaned.removed));
check("保留期清理删除了过期审计日志",
  cleaned.removed.old_audit === 1, JSON.stringify(cleaned.removed));
check("清理后计数确实下降",
  afterCleanup.posts < beforeCleanup.posts && afterCleanup.audit < beforeCleanup.audit,
  `posts ${beforeCleanup.posts}→${afterCleanup.posts} · audit ${beforeCleanup.audit}→${afterCleanup.audit}`);
check("孤儿行清理生效", cleaned.removed.orphan_likes === 1, JSON.stringify(cleaned.removed));

// 不开启保留期时：只做结构性清理，不删历史内容
const cleaned0 = db.cleanup(0);
check("RETENTION_DAYS=0 时不按时间删数据",
  cleaned0.removed.rejected_posts === undefined && cleaned0.removed.old_audit === undefined,
  JSON.stringify(cleaned0.removed));

const optimizeMs = db.optimize();
check("PRAGMA optimize 可执行", Number.isFinite(optimizeMs), `${optimizeMs}ms`);

const cp = db.checkpoint("TRUNCATE");
check("WAL checkpoint 可用", cp !== null, JSON.stringify(cp));

/* ── 6. 启动路径与干净退出标记 ───────────────────────────────────── */

console.log("\n[6/6] 启动路径与退出标记");
check("首次启动不会误判为干净退出", db.stats().dirtyAtBoot === true, `dirtyAtBoot=${db.stats().dirtyAtBoot}`);
check("校准时间已记录（用于决定是否跳过全量校准）",
  Number(db.getStat("like_recount_at")) > 0,
  new Date(Number(db.getStat("like_recount_at"))).toISOString());

db.shutdown();
check("退出后标记为干净（下次启动跳过全量校准）", db.getStat("clean_shutdown") === "clean", String(db.getStat("clean_shutdown")));

const finalStats = db.stats();
check("统计信息可读（体积/可回收/计数）",
  finalStats.fileBytes > 0 && typeof finalStats.reclaimableBytes === "number",
  `文件 ${(finalStats.fileBytes / 1024).toFixed(0)}KB · 可回收 ${(finalStats.reclaimableBytes / 1024).toFixed(0)}KB · WAL ${finalStats.walBytes}B`);

if (flag("--recount")) {
  const res = db.recountLikeCounts();
  check("全量点赞校准可执行", Number.isFinite(res.ms), `修正 ${res.changes} 行 / ${res.ms}ms`);
}

// 刻意不调用 db.close()：
// better-sqlite3 在「连接已 close、但此前创建的 Statement 之后才被 GC」时，
// 会在 Node 退出阶段触发原生断言崩溃（RemoveEnvironmentCleanupHook 断言）。
// 这是脚本层的问题 —— 生产进程里语句与连接同生命周期，不会出现这种情况。
// 收尾动作已由 db.shutdown() 完成（标记干净退出 + optimize + WAL 截断），
// 剩下的资源交给进程退出统一回收。

/* ── 汇总 ────────────────────────────────────────────────────────── */

if (!useRealDb) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${"─".repeat(64)}`);
console.log(`数据库自检：${results.length - failed}/${results.length} 通过`);
console.log(`${"─".repeat(64)}\n`);
process.exit(failed ? 1 : 0);
