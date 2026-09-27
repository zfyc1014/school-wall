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
-- ─────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_posts_feed;   -- 旧版含 created_at，改由 (status, id DESC) 承担
DROP INDEX IF EXISTS idx_posts_queue;  -- 旧版是全表索引，改为 pending 部分索引
DROP INDEX IF EXISTS idx_comments_queue;
DROP INDEX IF EXISTS idx_reports_open; -- 与 idx_reports_status 前缀重复，属多余索引

-- ─────────────────────────────────────────────────────────────────────────
-- 实名身份（后台实名，前台匿名）
--
-- 合规需求：前台展示匿名，但平台必须能追溯到发布者。这不是「用户账号」——
-- 没有密码、没有昵称、没有个人主页，只有一个已验证的手机号标识 + 同意记录。
-- 数据最小化原则：
--   * 存 HMAC 哈希（phone_hash），不存明文号码；哈希密钥独立于 IP 哈希密钥；
--   * 明文只在「提交验证码的那一次请求」的内存里存在，不落盘、不写日志；
--   * 需要联系发布者时，运营方凭哈希去短信网关/工单系统反查，
--     而不是让数据库里躺着一份可直接泄露的手机号清单。
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS identities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash     TEXT    NOT NULL UNIQUE,  -- HMAC-SHA256(归一化手机号, IDENTITY_SECRET)
  phone_masked   TEXT    NOT NULL,         -- 138****8000，仅供后台人工核对
  country_code   TEXT,                     -- 86 / 852 …
  method         TEXT    NOT NULL DEFAULT 'phone',
  verified_at    INTEGER NOT NULL,
  consent_version TEXT   NOT NULL,         -- 同意条款版本，留痕用
  consent_at     INTEGER NOT NULL,
  post_count     INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  last_seen_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_recent ON identities(verified_at DESC);

-- 短信验证码。只存哈希，明文码只在内存里比对。
CREATE TABLE IF NOT EXISTS identity_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hash  TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,            -- HMAC-SHA256(code, IDENTITY_SECRET)
  attempts    INTEGER NOT NULL DEFAULT 0,  -- 校验失败次数，超过上限即作废
  consumed_at INTEGER,                     -- 用过/作废的时间
  expires_at  INTEGER NOT NULL,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL
);
-- 取「某个号码最近一条未消费的码」是热查询，走这个索引
CREATE INDEX IF NOT EXISTS idx_codes_lookup ON identity_codes(phone_hash, consumed_at, id DESC);

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

-- 评论。默认即公开，命中规则才转 pending。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'approved',  -- approved | pending | rejected | removed
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
