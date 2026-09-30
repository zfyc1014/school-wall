"use strict";

/**
 * SQLite 连接、调优与数据维护。
 *
 * 低配 VPS 取舍：单进程 + WAL + NORMAL 同步，牺牲极小概率的掉电一致性，
 * 换取接近零的写放大，以及不需要独立数据库服务的内存开销。
 *
 * 这里集中处理三件在低配机器上最容易翻车的事：
 *
 *   1. **启动不做全表校准。**
 *      旧实现每次启动都执行
 *        UPDATE posts SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = posts.id)
 *      这是「每行一次 likes 范围扫描」，帖量与点赞量上去后启动会卡住数秒到数十秒，
 *      1 vCPU 上尤其明显。现在改为：只有上次不是优雅退出（脏标记）或距上次校准
 *      超过 RECOUNT_DAYS 天才做一次，其余情况信任批量回写维护的计数。
 *
 *   2. **WAL 不允许无限增长。**
 *      WAL 长期不 checkpoint 会一直长大，最终把磁盘吃满。这里定时 TRUNCATE
 *      checkpoint（空闲时执行，几乎不影响在线请求）。
 *
 *   3. **历史数据必须有保留期。**
 *      likes / reports / audit_log / 被拒内容会随时间无限堆积。cleanup() 按
 *      RETENTION_DAYS 清理，并对已下架帖子直接删除行（级联带走点赞与评论），
 *      这样主键表不会无限膨胀。
 *
 * 维护入口：
 *   - 启动时：清理过期临时对象（MEMORY journal）、必要时校准、一次 TRUNCATE checkpoint
 *   - 运行中：wal_checkpoint 定时器 + cleanup 定时器（均 unref，不阻止进程退出）
 *   - 退出时：标记干净退出 + PRAGMA optimize + TRUNCATE checkpoint
 *   - 需要时：node scripts/db-check.js --recount 强制校准
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.resolve(
  process.env.DB_PATH || path.join(__dirname, "..", "data", "wall.db")
);

const IS_PROD = process.env.NODE_ENV === "production";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

/* ───────────────────────────── 连接调优 ───────────────────────────── */

db.pragma("journal_mode = WAL");       // 读写不互相阻塞，单写多读场景最优
db.pragma("synchronous = NORMAL");     // WAL 下足够安全，省掉每次提交的 fsync 等待
db.pragma("foreign_keys = ON");        // 点赞/评论随帖子级联清理
db.pragma("busy_timeout = 5000");      // 后台维护与在线写入可能短暂争锁
db.pragma("temp_store = MEMORY");      // 临时 B 树放内存，避免碰磁盘

/**
 * 页缓存按机器内存自动定档，而不是写死 4MB。
 * 1GB 内存的机器给 16MB，换来的是热数据全在内存里 —— 这点开销远小于
 * 一次磁盘随机读的代价（低配 VPS 多为网络盘，随机读尤其贵）。
 */
const TOTAL_MEM_MB = Math.floor(os.totalmem() / 1024 / 1024);
const CACHE_MB = Number(
  process.env.DB_CACHE_MB || (TOTAL_MEM_MB <= 1024 ? 16 : TOTAL_MEM_MB <= 2048 ? 32 : 64)
);
db.pragma(`cache_size = -${CACHE_MB * 1024}`); // 负值 = KiB

/** mmap 上限与缓存同量级：读取直接映射页，省一次内核拷贝 */
db.pragma(`mmap_size = ${CACHE_MB * 1024 * 1024}`);

// 只在 WAL 真正大到需要回收时才自动 checkpoint：默认 1000 页（约 4MB，按 4KB 页）
// 意味着写事务频率高时 WAL 会被频繁截断，反而增加 IO。定时器负责这件事。
db.pragma("wal_autocheckpoint = 4000");

/**
 * 关掉自动统计收集（auto_analyze）。
 *
 * 原因是一次实测：表很小的时候，有了 sqlite_stat1 之后 SQLite 会因为
 * 「status='approved' 命中整表」而放弃索引，把首屏查询变成全表扫描 + 排序。
 * 小表无所谓，但帖子涨到几万条后每次读首屏都要扫全表。
 *
 * 我们的做法是让关键索引**覆盖**查询列（见 schema.sql 的说明），
 * 这样优化器在任何统计信息下都会用索引；同时不让统计信息在运行中
 * 悄悄改变查询计划 —— 低配机器上「计划稳定」比「计划可能更聪明」更值钱。
 * 需要统计信息时用 `node scripts/db-check.js` 或 PRAGMA optimize 手动触发。
 */
db.pragma("auto_analyze = 0");

/* ───────────────────────────── 结构 ───────────────────────────── */

db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));

/* ───────────────────── 内测版迁移（幂等）───────────────────── */

/**
 * 内测版（0.9）删除实名制后，从旧库升级上来的数据库里会留下
 * `identities` / `identity_codes` 两张表与三处 `identity_id` 列。
 *
 * 处理原则：**尽力清理，失败不影响启动**。
 *   - 新库根本不会建这些对象（schema.sql 已删除），这段只对旧库生效；
 *   - DROP COLUMN 要求该列不被索引/约束引用，因此先删索引再删列；
 *   - 万一数据库版本或约束不允许删除，就退化为「保留空列不再使用」——
 *     绝不能因为一次清理失败就让服务起不来。
 */
function tableExists(table) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function dropColumnIfExists(table, column) {
  if (!tableExists(table)) return false;
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) return false;
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    console.log(`[db] 迁移：已移除 ${table}.${column}（内测版不再收集实名信息）`);
    return true;
  } catch (err) {
    console.warn(`[db] 迁移：${table}.${column} 无法删除（${err.message}），已保留为空列，代码不再读写`);
    return false;
  }
}

if (tableExists("identities") || tableExists("identity_codes")) {
  console.log("[db] 检测到实名时代的旧表，正在清理（内测版不收集手机号）");
}
db.exec("DROP INDEX IF EXISTS idx_posts_identity");
db.exec("DROP INDEX IF EXISTS idx_comments_identity");
db.exec("DROP INDEX IF EXISTS idx_reports_identity");
db.exec("DROP TABLE IF EXISTS identity_codes");
db.exec("DROP TABLE IF EXISTS identities");
dropColumnIfExists("posts", "identity_id");
dropColumnIfExists("comments", "identity_id");
dropColumnIfExists("reports", "identity_id");

/* ───────────────────── 上次是否干净退出 ───────────────────── */

const DIRTY_KEY = "clean_shutdown";

function getStat(key) {
  const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setStat(key, value) {
  db.prepare(
    `INSERT INTO stats (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), Date.now());
}

let dirtyAtBoot = false;

/* ─────────────────── 维护：校准 / 清理 / 统计 ─────────────────── */

/**
 * 全量重算点赞缓存。
 * 这是 O(帖子数 × 该帖点赞数) 的操作，**只应在崩溃恢复或骨架升级后执行**，
 * 不能放进常规启动路径。执行时间会打印出来，方便判断是否该换更省的做法。
 */
function recountLikeCounts() {
  const started = Date.now();
  const info = db.prepare(
    `UPDATE posts
        SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = posts.id)
      WHERE like_count <> (SELECT COUNT(*) FROM likes WHERE post_id = posts.id)`
  ).run();
  setStat("like_recount_at", Date.now());
  const ms = Date.now() - started;
  console.log(`[db] 点赞缓存校准完成：修正 ${info.changes} 行，耗时 ${ms}ms`);
  return { changes: info.changes, ms };
}

function maybeRecountLikeCounts(reason) {
  const force = process.env.DB_RECOUNT_ON_BOOT === "1";
  const last = Number(getStat("like_recount_at") || 0);
  const maxAgeMs = Number(process.env.DB_RECOUNT_DAYS || 7) * 86400000;

  if (!force && !dirtyAtBoot && last && Date.now() - last < maxAgeMs) return null;

  const why = force ? "环境变量要求" : dirtyAtBoot ? `${reason}（上次非优雅退出）` : "距上次校准已超过保留期";
  console.log(`[db] 触发全量点赞校准：${why}`);
  return recountLikeCounts();
}

/**
 * 保留期清理。默认关闭（RETENTION_DAYS=0），
 * 因为「删数据」必须由运营方明确同意后再开启 —— 合规上也需要有明确依据。
 *
 * @param {number} days 保留天数；<=0 表示只做无争议的结构性清理
 */
function cleanup(days = Number(process.env.RETENTION_DAYS || 0)) {
  const removed = {};

  const run = (label, sql, ...args) => {
    const info = db.prepare(sql).run(...args);
    if (info.changes) removed[label] = info.changes;
  };

  // 无争议的结构性清理：主键表里指向已不存在帖子的孤儿行。
  // （posts 删除时 likes/comments 有外键级联，但历史数据可能来自早期没有外键的版本）
  run("orphan_likes", "DELETE FROM likes WHERE post_id NOT IN (SELECT id FROM posts)");
  run("orphan_comments", "DELETE FROM comments WHERE post_id NOT IN (SELECT id FROM posts)");

  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;

    // 被拒内容：保留期满即物理删除（同时释放正文占用的空间）
    run("rejected_posts", "DELETE FROM posts WHERE status = 'rejected' AND created_at < ?", cutoff);
    run("stale_comments",
      "DELETE FROM comments WHERE status IN ('rejected','removed') AND created_at < ?", cutoff);
    // 已结案工单与审计日志：保留期满清理
    run("closed_reports",
      "DELETE FROM reports WHERE status <> 'open' AND created_at < ?", cutoff);
    run("old_audit", "DELETE FROM audit_log WHERE created_at < ?", cutoff);
    // 已处理的内测反馈：保留期满清理（未处理的永远保留，不能被时间清掉）
    run("old_feedback",
      "DELETE FROM feedback WHERE status <> 'open' AND created_at < ?", cutoff);
  } else {
    // 未开启保留期时，仍然清掉「已下架帖子」，因为下架即不再需要保留正文。
    // 该动作同时通过外键级联清掉它的点赞与评论，直接缩小主键表体积。
    run("removed_posts", "DELETE FROM posts WHERE status = 'removed'");
  }

  const freed = db.prepare("PRAGMA freelist_count").pluck().get();
  db.exec("PRAGMA incremental_vacuum"); // 需要 auto_vacuum=INCREMENTAL 才有效

  return { removed, freedPages: freed, days };
}

/** 让 SQLite 自己决定该更新哪些统计信息（比 ANALYZE 全表便宜得多） */
function optimize() {
  const started = Date.now();
  db.exec("PRAGMA optimize");
  const ms = Date.now() - started;
  if (ms > 50) console.log(`[db] PRAGMA optimize 耗时 ${ms}ms`);
  return ms;
}

/** 把 WAL 截断回主库文件：控制 -wal 体积，并让下次打开更快 */
function checkpoint(mode = "TRUNCATE") {
  try {
    const row = db.pragma(`wal_checkpoint(${mode})`);
    return Array.isArray(row) ? row[0] : row;
  } catch (err) {
    console.warn("[db] checkpoint 失败：", err.message);
    return null;
  }
}

/** 体积概览，供 /api/admin/stats 与 db-check 脚本使用 */
function stats() {
  const pageSize = db.pragma("page_size", { simple: true });
  const pageCount = db.pragma("page_count", { simple: true });
  const freelist = db.pragma("freelist_count", { simple: true });
  const count = (sql) => db.prepare(sql).pluck().get();

  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${DB_PATH}-wal`).size;
  } catch { /* 无 WAL 文件 */ }

  return {
    path: DB_PATH,
    pageSize,
    pageCount,
    freelistPages: freelist,
    fileBytes: pageCount * pageSize,
    reclaimableBytes: freelist * pageSize,
    walBytes,
    cacheMb: CACHE_MB,
    counts: {
      posts: count("SELECT COUNT(*) FROM posts"),
      approved: count("SELECT COUNT(*) FROM posts WHERE status = 'approved'"),
      pending: count("SELECT COUNT(*) FROM posts WHERE status = 'pending'"),
      comments: count("SELECT COUNT(*) FROM comments"),
      likes: count("SELECT COUNT(*) FROM likes"),
      reports: count("SELECT COUNT(*) FROM reports"),
      feedback: count("SELECT COUNT(*) FROM feedback"),
      audit: count("SELECT COUNT(*) FROM audit_log")
    },
    autoVacuum: db.pragma("auto_vacuum", { simple: true }),
    dirtyAtBoot
  };
}

/* ───────────────────────────── 启动维护 ───────────────────────────── */

/**
 * auto_vacuum 必须在建表之前设定，且只能在空库上生效；
 * 这里只做一次检测并给出提示，不擅自改动既有库（改动需要 VACUUM 重建整个文件）。
 */
if (db.pragma("auto_vacuum", { simple: true }) === 0) {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM posts").get().n;
  if (rows === 0) {
    db.pragma("auto_vacuum = INCREMENTAL");
  } else {
    console.warn(
      "[db] auto_vacuum=0：删除历史数据后空间不会自动回收。"
      + "如需回收，请在维护窗口执行 VACUUM（见 README 数据库维护一节）。"
    );
  }
}

/**
 * 上次是否优雅退出：非优雅退出说明进程可能死在写事务中间，需要校准计数。
 *
 * 这里有个容易写错的细节（本项目踩过一次）：
 *   dirtyAtBoot 必须由**上一个**标记值算出，然后**无条件**把标记改成 "open"。
 *   如果写成 `dirtyAtBoot = !getStat(DIRTY_KEY)`，那么崩溃留下的 "open" 会被
 *   判成 false —— 「上次非优雅退出 → 全量校准」这条路径实际永远走不到。
 *   反过来说，无条件写 "open" 的代价是：有人手工开库看一眼又不写回 "clean"
 *   （体检脚本 db-check 会在结束时调用 shutdown() 写回），下次启动会多做一次
 *   全量校准 —— 校准是幂等的，宁可贵一点，也不能漏掉计数不一致。
 */
const previousState = getStat(DIRTY_KEY);
dirtyAtBoot = previousState !== "clean";
setStat(DIRTY_KEY, "open");

maybeRecountLikeCounts("启动检测");

// 打开时先截断一次：把上次进程遗留的 WAL 收回到主库，避免 -wal 一路变大
checkpoint("TRUNCATE");
// 启动顺手清理孤儿行（很便宜，且能保证外键语义成立）
try {
  cleanup();
} catch (err) {
  console.warn("[db] 启动清理失败：", err.message);
}

/* ───────────────────────────── 定时维护 ───────────────────────────── */

const CHECKPOINT_MS = Number(process.env.DB_CHECKPOINT_MS || 5 * 60 * 1000);
const CLEANUP_MS = Number(process.env.DB_CLEANUP_MS || 6 * 60 * 60 * 1000);

const checkpointTimer = setInterval(() => {
  const row = checkpoint("TRUNCATE");
  if (row && row.checkpointed) {
    console.log(`[db] checkpoint 回收 ${row.checkpointed} 页`);
  }
}, CHECKPOINT_MS);
checkpointTimer.unref();

const cleanupTimer = setInterval(() => {
  try {
    const res = cleanup();
    const total = Object.values(res.removed).reduce((a, b) => a + b, 0);
    if (total) console.log(`[db] 保留期清理：删除 ${total} 行`, res.removed);
    optimize();
  } catch (err) {
    console.warn("[db] 定时清理失败：", err.message);
  }
}, CLEANUP_MS);
cleanupTimer.unref();

/* ───────────────────────────── 优雅退出 ───────────────────────────── */

/**
 * 收尾：标记干净退出 → 刷新统计 → 截断 WAL。
 * 必须在 process.exit 之前调用，否则下次启动会被判定为「脏」而触发全量校准。
 */
function shutdown() {
  try {
    setStat(DIRTY_KEY, "clean");
    setStat("last_shutdown_at", Date.now());
    optimize();
    checkpoint("TRUNCATE");
  } catch (err) {
    console.warn("[db] 退出收尾失败：", err.message);
  }
}

module.exports = db;
module.exports.DB_PATH = DB_PATH;
module.exports.CACHE_MB = CACHE_MB;
module.exports.checkpoint = checkpoint;
module.exports.cleanup = cleanup;
module.exports.optimize = optimize;
module.exports.stats = stats;
module.exports.shutdown = shutdown;
module.exports.recountLikeCounts = recountLikeCounts;
module.exports.getStat = getStat;
module.exports.setStat = setStat;
