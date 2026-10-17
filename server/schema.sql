-- ─────────────────────────────────────────────────────────────────────────
-- 校园墙 v1.0.0 · SQLite schema（WAL）
-- 设计取向：低配 VPS 友好 —— 单文件、无独立数据库进程、keyset 分页走索引。
-- 由 src/db.js 在启动时执行，幂等（IF NOT EXISTS）。
--
-- 索引预算：只建「查询真的会走」的索引。每个索引都会拖慢写入并占用内存，
-- 低配机器上宁可用更少的索引 + 更准的统计信息（PRAGMA optimize）。
--
-- 迁移策略：下面的 DROP 是幂等的，用来清掉旧版本建过、现在已由更合适的索引
-- 取代的索引（索引名相同但列不同时，CREATE INDEX IF NOT EXISTS 不会自动改，
-- 必须显式 DROP 再建）。每次启动执行一次，代价可忽略。
-- 列的增删由 src/db.js 的迁移函数负责（ADD COLUMN / RENAME COLUMN 都是增量的）。
--
-- ── v1.0.0 索引复核 ─────────────────────────────────────────────────────
--
--   users          邮箱与 uuid 的 UNIQUE 约束自带索引；另加 created_at 倒序一条
--                  供后台「最新注册」列表；昵称模糊搜索走 LIKE（后台低频，可接受）。
--   auth_codes     (email, created_at DESC) 覆盖「取该邮箱最新验证码」。
--   sessions       token_hash 主键即索引；(user_id) 供「退出全部设备」；
--                  (expires_at) 供定时清理过期会话。
--   announcements  (active, sort, id DESC) 覆盖首页公告读取。
--   forum_threads  (board, status, last_reply_at DESC, id DESC) 覆盖版块列表两种排序；
--                  (author_id, id DESC) 供个人主页。
--   forum_replies  (thread_id, status, id) 覆盖楼层读取与审核队列。
--   thread_likes   主键 (thread_id, user_id) 天然去重。
--   friendships    (addressee_id, status, updated_at DESC) 覆盖「待处理好友请求」。
--   dm_messages    (sender_id, recipient_id, id DESC) 覆盖单聊；(recipient_id, read_at, id DESC)
--                  覆盖未读数与会话列表。
--   合计新增 10 条索引，全部对应真实存在的热查询；没有任何「为了对称」建的索引。
-- ─────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_posts_feed;   -- 旧版含 created_at，改由 (status, id DESC) 承担
DROP INDEX IF EXISTS idx_posts_queue;  -- 旧版是全表索引，改为 pending 部分索引
DROP INDEX IF EXISTS idx_comments_queue;
DROP INDEX IF EXISTS idx_reports_open; -- 与 idx_reports_status 前缀重复，属多余索引

-- ── 账号体系（v1.0.0 新增）──────────────────────────────────────────────
--
-- 用户对外唯一标识是 uuid，不是自增 id：自增 id 会泄露注册顺序与总量，
-- 且一旦换库/迁移就会撞车。uuid 也是私信、好友、主页 URL 里出现的那个值。
--
-- school 一旦写入不可更改（业务上由服务端强约束：PATCH /api/me 不接受 school）。
-- 它同时是「这个账号属于哪个学校」的唯一依据，展示在用户主页最前面。
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT    NOT NULL UNIQUE,
  -- 邮箱与手机号**至少有一个**：注册时用户自选一种，两者都可以作为登录身份。
  -- 手机号注册的用户 email 为 NULL —— 所以 email 这里不能加 NOT NULL。
  email            TEXT    UNIQUE,                   -- 小写归一后存储
  phone            TEXT,                             -- E.164（+8613800138000）
  phone_verified_at INTEGER,                         -- 短信验证通过的时间；NULL = 未验证
  nickname         TEXT    NOT NULL,
  nickname_flagged TEXT,                             -- 命中预筛的规则名；非空即需人工复核
  school           TEXT    NOT NULL,
  avatar           TEXT    NOT NULL DEFAULT '',
  bio              TEXT    NOT NULL DEFAULT '',
  title_id         INTEGER,
  level            INTEGER NOT NULL DEFAULT 1,
  exp              INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'active', -- active | muted | banned
  muted_until      INTEGER,
  last_nickname_at INTEGER,                           -- 昵称冷却用
  ip_hash          TEXT,
  ua_hash          TEXT,
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER,
  last_seen_at    INTEGER,
  -- 概览页的「IP 来源 / 访问设备」：只存粗粒度信息，不落原始 IP（站长看不到完整 IP）
  last_country     TEXT,                             -- Cloudflare CF-IPCountry，如 CN / HK
  last_device      TEXT,                             -- 解析后的设备标签，如「iPhone · Safari」
  last_ip_masked   TEXT,                             -- 打码 IP，如 1.2.3.*
  -- 硬约束：不允许出现「既没邮箱也没手机号」的账号（否则永远登录不进来）
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
-- 后台「最新注册」列表：ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC, id DESC);
-- 手机号唯一（部分索引：NULL 不算重复，未绑定的用户不互相冲突）。
-- ⚠️ 这条索引依赖 users.phone 列：老库必须先由 db.js 的 ensureUpgradeColumns() 补列，
--    否则 schema 执行到这里会直接报 "no such column"（v1.0.0 踩过同一个坑）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- 登录验证码（邮箱或短信）。只存 HMAC，不存明文 —— 数据库泄露也不能直接拿来登录。
-- attempts 计数与 expires_at 一起构成「5 次错误即作废」的实现。
-- 注意：email 列是**目标地址**的通用载体 —— channel='email' 时是邮箱，
-- channel='phone' 时是 E.164 手机号。历史列名没有改（改名要重建表，风险大于收益）。
CREATE TABLE IF NOT EXISTS auth_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  channel     TEXT    NOT NULL DEFAULT 'email',   -- email | phone
  code_hash   TEXT    NOT NULL,
  purpose     TEXT    NOT NULL DEFAULT 'login',   -- login | register | bind
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_lookup ON auth_codes(email, created_at DESC);

-- 会话。token 本身不落盘（只存 SHA-256），cookie 里的随机串是唯一凭据。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT,
  ua_hash      TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- 一次性注册令牌：验证码通过但还没填昵称/学校时签发，15 分钟有效。
-- email 列是**目标地址**的通用载体（与 auth_codes 同口径）：channel=phone 时存的是 E.164 手机号。
CREATE TABLE IF NOT EXISTS register_tokens (
  token_hash TEXT    PRIMARY KEY,
  email      TEXT    NOT NULL,
  channel    TEXT    NOT NULL DEFAULT 'email',      -- email | phone
  ip_hash    TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
) WITHOUT ROWID;

-- 头衔。auto=1 表示「达到 min_level 自动获得」，否则只能由管理员手动指定。
-- color 留空表示用站点默认强调色，不强制配色。
CREATE TABLE IF NOT EXISTS user_titles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  color      TEXT    NOT NULL DEFAULT '',
  min_level  INTEGER NOT NULL DEFAULT 1,
  auto       INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 学校名单。**由后台维护**（/houtai/ 的「学校管理」），不再从文件生成：
-- 学校是本校本地的运营数据，谁在用、什么时候加，只有运营方知道。
--
-- 注意 users.school 存的是**校名快照**而不是外键：管理员删掉/改名一个学校时，
-- 已经选了它的用户不受影响（学校一经选择不可更改是产品承诺，不能因为运营
-- 调整名单就让人"失去学校"）。因此这里删行是安全的。
CREATE TABLE IF NOT EXISTS schools (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schools_active ON schools(active, sort, id);

-- 首页公告栏。后台可增删改；active=0 即下线但保留内容。
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT    NOT NULL,
  link       TEXT,
  link_text  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, sort, id DESC);

-- ── 表白墙（既有）───────────────────────────────────────────────────────
--
-- 帖子。默认 status='pending'：先审后发。
-- user_id 只服务后台追责与「我的发布」，**前台任何接口都不返回**（匿名是产品前提）。
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
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
--   正文 body 不进索引 —— 那会让索引体积翻倍、写入翻倍。
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_hot  ON posts(status, like_count, id);
CREATE INDEX IF NOT EXISTS idx_posts_cat  ON posts(status, cat, created_at, id);
-- 个人主页「我的发布」：只查自己的帖子（后台与 /me 用），不参与公开列表
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id DESC);

-- 评论。默认 status='pending'：与帖子同口径，先审后发。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending',  -- approved | pending | rejected | removed
  flag       TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments(post_id, status, id);
CREATE INDEX IF NOT EXISTS idx_comments_queue ON comments(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_comments_user  ON comments(user_id, id DESC);

-- 点赞去重：主键天然防重复，可在高并发下安全 upsert。
-- actor 是「谁点的」：登录用户写 u:<uuid>，这样换设备仍然是同一个人。
CREATE TABLE IF NOT EXISTS likes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  actor      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, actor)
) WITHOUT ROWID;

-- ── 论坛（v1.0.0 新增）──────────────────────────────────────────────────
--
-- 与表白墙的关键区别：**署名**。论坛展示昵称/头衔/等级，是有身份的讨论区；
-- 表白墙保持匿名。两者共用同一套预筛（moderation.js）。
--
-- board 白名单在服务端硬编码（general | study | life | lost），不建表：
-- 版块是产品结构而不是运营数据，建模成表只会多一次 JOIN。
CREATE TABLE IF NOT EXISTS forum_threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board         TEXT    NOT NULL DEFAULT 'general',
  author_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'approved', -- approved | pending | removed
  flag          TEXT,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  like_count    INTEGER NOT NULL DEFAULT 0,
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_reply_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_board  ON forum_threads(board, status, last_reply_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_new    ON forum_threads(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_hot    ON forum_threads(status, like_count DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_author ON forum_threads(author_id, id DESC);

CREATE TABLE IF NOT EXISTS forum_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'approved',
  flag       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_thread ON forum_replies(thread_id, status, id);
CREATE INDEX IF NOT EXISTS idx_replies_author ON forum_replies(author_id, id DESC);

CREATE TABLE IF NOT EXISTS thread_likes (
  thread_id  INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;

-- ── 好友与私信（v1.0.0 新增）────────────────────────────────────────────
--
-- 单向存一行，A→B 的请求就是 (requester=A, addressee=B)。
-- 「成为好友」= 存在一行 status='accepted'（无论方向）；加好友时若对方已向我发过请求，
-- 直接把那一行改成 accepted —— 这正是微信/QQ 的「互相添加即刻成为好友」。
CREATE TABLE IF NOT EXISTS friendships (
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | declined | blocked
  message      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dm_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_pair  ON dm_messages(sender_id, recipient_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_inbox ON dm_messages(recipient_id, read_at, id DESC);

-- ── 爱发电赞助订单（v1.0.0 接入）────────────────────────────────────────
--
-- 数据流：爱发电下单成功 → 平台 POST 到 /api/afdian/webhook → 这里落一行。
-- **out_trade_no 唯一**是整条链路的关键：爱发电没收到 200 响应就会重试，
-- 有唯一约束时重放退化成一次 INSERT OR IGNORE，绝不会重复发奖。
--
-- amount 存字符串而不是 REAL：金额是定点小数，浮点会引入 0.1+0.2 这类误差；
-- 这些值只用于展示与对账，不参与计算。
CREATE TABLE IF NOT EXISTS afdian_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  out_trade_no TEXT    NOT NULL UNIQUE,
  afdian_user  TEXT,                        -- 爱发电侧的赞助者 id
  plan_id      TEXT,
  amount       TEXT,                        -- 实付金额（字符串）
  months       INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 0,  -- 2 = 支付成功
  remark       TEXT,                        -- 下单留言：用来匹配本站账号
  user_id      INTEGER,                     -- 匹配到的本站用户（可空，后台可手动绑定）
  matched_by   TEXT,                        -- remark_uuid | remark_email | admin | none
  reward       TEXT,                        -- 实际发放内容（追溯「谁因为哪一单拿到了什么」）
  title_id     INTEGER,                     -- 本次发放的头衔 id（升级判定用：赞助给的头衔可被更高档位覆盖，手动头衔不行）
  raw          TEXT,                        -- 原始报文（截断保存，排查用）
  created_at   INTEGER NOT NULL,            -- 爱发电订单时间（毫秒）
  received_at  INTEGER NOT NULL             -- 本站收到时间
);
CREATE INDEX IF NOT EXISTS idx_afdian_user     ON afdian_orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_afdian_received ON afdian_orders(received_at DESC);
-- 待绑定队列：还没匹配到本站账号的订单
CREATE INDEX IF NOT EXISTS idx_afdian_unbound  ON afdian_orders(user_id, status);

-- ── 举报 / 工单 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  comment_id  INTEGER,
  reporter_id INTEGER,
  reason      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',      -- open | actioned | dismissed
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
-- 工单列表：按 status 过滤 + 时间倒序。status 是共同前缀，一条索引覆盖两种查询。
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id DESC);
-- 同一来源对同一帖反复举报的去重判断
CREATE INDEX IF NOT EXISTS idx_reports_post   ON reports(post_id, ip_hash);

-- ── 意见反馈 ────────────────────────────────────────────────────────────
--
-- 刻意做得很窄：contact 选填；三态够用；不参与公开内容，因此不进 feed 缓存，
-- 也没有任何对外读取接口。队列查询是「status 等值 + id 倒序」。
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
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
CREATE TABLE IF NOT EXISTS stats (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
