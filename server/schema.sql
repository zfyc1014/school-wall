-- ─────────────────────────────────────────────────────────────────────────
-- 校园表白墙 · SQLite schema（WAL）
-- 设计取向：低配 VPS 友好 —— 单文件、无独立数据库进程、keyset 分页走索引。
-- 由 src/db.js 在启动时执行，幂等（IF NOT EXISTS）。
--
-- 索引预算：只建「查询真的会走」的索引。每个索引都会拖慢写入并占用内存，
-- 低配机器上宁可用更少的索引 + 更准的统计信息（PRAGMA optimize）。
--
-- 迁移策略：下面的 DROP 是幂等的，用来清掉旧版本建过、现在已由更合适的索引
-- 取代的索引（索引名相同但列不同时，CREATE INDEX IF NOT EXISTS 不会自动改，
-- 必须显式 DROP 再建）。每次启动执行一次，代价可忽略。
--
-- ── 后台审核链路复核（本轮）────────────────────────────────────────────
--
-- 新增的审核接口全部复用既有索引，没有引入第 9 个索引。逐条对照：
--
--   GET /api/admin/queue?type=posts      待审帖子按 created_at ASC 取
--     → idx_posts_feed(status, created_at, id) 正序遍历即时间升序，覆盖所需列
--       （cat/body/flag 之外的 like_count/comment_count 需回表，但待审集很窄，
--        每次最多 100 行，回表代价可忽略）。
--
--   GET /api/admin/queue?type=comments   待审评论按时间升序 + 关联帖子上下文
--     → idx_comments_queue(status, created_at, id) 正序遍历；
--       帖子上下文由 posts 主键点查（LEFT JOIN），不产生额外索引需求。
--
--   GET /api/admin/stats                 队列最久等待 = 两条 ORDER BY created_at ASC LIMIT 1
--     → 同样吃 idx_posts_feed / idx_comments_queue 的索引头部，零额外开销。
--
--   GET /api/admin/reports               工单按 status 过滤 + id DESC
--     → idx_reports_status(status, id DESC) 完全覆盖排序；
--       被举报内容由 posts/comments 主键点查补齐。
--
--   GET /api/admin/audit                 操作留痕按 id DESC
--     → idx_audit_time(created_at DESC) 覆盖；id 与 created_at 同序，语义等价。
--
-- 结论：**不新增索引**。审核是「低频读 + 高频写」的链路，多一个索引就多一份
-- 写入放大；既有 8 个索引已经覆盖审核侧的全部热查询。
--
-- 内测版（0.9）在这一版之上只加了 1 个索引：idx_feedback_status —— 内测反馈是
-- 本期唯一的新表，它的后台队列查询（status 等值 + id 倒序）必须走索引，
-- 否则每次打开后台都要扫全表。合计 9 个索引，db-check.js 里写死断言。
-- ─────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_posts_feed;   -- 旧版含 created_at，改由 (status, id DESC) 承担
DROP INDEX IF EXISTS idx_posts_queue;  -- 旧版是全表索引，改为 pending 部分索引
DROP INDEX IF EXISTS idx_comments_queue;
DROP INDEX IF EXISTS idx_reports_open; -- 与 idx_reports_status 前缀重复，属多余索引

-- 内测版清理：实名时代的索引与表（幂等；新库里本来就不存在）。
-- 内测阶段不再收集手机号，因此这两张表和它们的索引一并抹掉；
-- 旧库里的 identity_id 列由 db.js 的迁移尽力删除（失败则保留为空列）。
DROP INDEX IF EXISTS idx_identities_recent;
DROP INDEX IF EXISTS idx_codes_lookup;
DROP INDEX IF EXISTS idx_posts_identity;
DROP INDEX IF EXISTS idx_comments_identity;
DROP INDEX IF EXISTS idx_reports_identity;
DROP TABLE IF EXISTS identity_codes;
DROP TABLE IF EXISTS identities;

-- 帖子。默认 status='pending'：先审后发。
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cat           TEXT    NOT NULL,                 -- 表白 / 树洞 / 寻人 / 失物 / 致谢
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected | removed
  like_count    INTEGER NOT NULL DEFAULT 0,       -- 点赞缓存，由 likes 表批量回写
  comment_count INTEGER NOT NULL DEFAULT 0,
  flag          TEXT,                             -- 规则命中的原因（逗号分隔），供人工复核
  ip_hash       TEXT,                             -- 不可逆哈希，不存原始 IP
  ua_hash       TEXT,
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER
);

-- ── 列表页索引：关键在于「覆盖索引」─────────────────────────────────────
--
-- 一个实测出来的坑，值得写下来：
--   建 (status, id) 后，**没有统计信息时**查询计划是
--     SEARCH posts USING INDEX idx_posts_feed (status=?)
--   而跑过 ANALYZE、有了 sqlite_stat1 之后会变成
--     SCAN posts
--   原因是 status='approved' 几乎命中整表，优化器于是认为「全表扫 + 排序」更便宜。
--   对小表确实如此；但帖子长到几万条以后，每次读首屏都要把整表拉一遍。
--
--   解决办法不是反复调索引，而是让索引**覆盖查询需要列**：
--   (status, created_at, id) 已包含列表要返回的全部列，SQLite 只读索引就能出结果
--   （查询计划里显示为 COVERING INDEX），优化器在任何统计信息下都不会放弃它。
--   连带好处：同一索引反向遍历即「最新在前」，正序遍历即按时间升序（审核队列用），
--   一个索引同时服务两个热查询。正文 body 不进索引 —— 那会让索引体积翻倍、
--   写入翻倍，而覆盖索引已经避免了回表，没必要。
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(status, created_at, id);
-- 热榜：WHERE status=? + ORDER BY like_count DESC, id DESC 由同一索引满足
CREATE INDEX IF NOT EXISTS idx_posts_hot  ON posts(status, like_count, id);
-- 分类页：等值 status, cat 之后按时间取序（与首屏同样的 keyset 翻页方式）。
-- 为什么不按 like_count 建：分类页默认是「最新」排序，按时间才吃到索引；
-- 分类 + 最热（可选项）只在一个分类的小结果集上排序，代价可接受。
CREATE INDEX IF NOT EXISTS idx_posts_cat  ON posts(status, cat, created_at, id);

-- 评论。默认 status='pending'：与帖子同口径，先审后发。
-- （曾经这里写的是 DEFAULT 'approved'，与 server.js 的写入路径不一致 ——
--   即使调用方忘了带 status，也不该有任何评论绕过审核直接公开。）
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending',  -- approved | pending | rejected | removed
  flag       TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
-- 评论：按帖取评论（post_id + status 前缀已覆盖），同时覆盖审核队列查询
-- （status='pending' 时按 created_at 升序取，列全在索引里，不回表）
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status, id);
CREATE INDEX IF NOT EXISTS idx_comments_queue ON comments(status, created_at, id);

-- 点赞去重：主键天然防重复，可在高并发下安全 upsert。
CREATE TABLE IF NOT EXISTS likes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  ip_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, ip_hash)
) WITHOUT ROWID;

-- 举报 / 通知—移除工单。
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  comment_id  INTEGER,
  reason      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',      -- open | actioned | dismissed
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
-- 工单列表：按 status 过滤 + 时间倒序。
-- 注意这里**只需要一个**索引：status 是共同前缀，(status, id DESC) 已经能覆盖
-- 「只查 open」和「查任意 status」两种查询。再为 open 单独建部分索引属于重复投资 ——
-- 每个多余的索引都会拖慢写入并多占内存，低配机器上不值得。
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id DESC);
-- 同一 IP 对同一帖反复举报的去重判断
CREATE INDEX IF NOT EXISTS idx_reports_post   ON reports(post_id, ip_hash);

-- ─────────────────────────────────────────────────────────────────────────
-- 内测反馈（0.9 新增）
--
-- 内测阶段最重要的输入渠道。刻意做得很窄：
--   * contact 选填 —— 不留联系方式也能提交，避免为了收反馈而收集个人信息；
--   * status 只有 open / done / dismissed 三态，够用且不需要工作流引擎；
--   * 不参与公开内容，因此不进 feed 缓存，也没有任何对外读取接口。
-- 队列查询是「status 等值 + id 倒序」，由 idx_feedback_status 一条索引覆盖。
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cat         TEXT    NOT NULL DEFAULT 'other',   -- bug | idea | other
  body        TEXT    NOT NULL,
  contact     TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',    -- open | done | dismissed
  ip_hash     TEXT,
  ua_hash     TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id DESC);

-- 审核操作日志（追责与合规留痕；管理员身份以 ip_hash 记录）
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT    NOT NULL,
  target     TEXT,
  note       TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

-- 计数器：把「启动/定期校准」这类全表维护的元信息记在这里。
-- 例如 like_recount_at 用来判断距离上次校准过了多久，避免每次启动都做全表校准。
CREATE TABLE IF NOT EXISTS stats (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
