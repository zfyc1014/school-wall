# 更新日志

本文件记录校园表白墙的版本变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 说明：仓库在 `0.9.0-beta.1` 之前没有 `CHANGELOG.md`，因此 `2.0.0` 与 `2.1.0` 两条
> 是依据 git 历史（`ebb0c36`、`bd5d85e`）与当时的 `README.md` / `DEPLOY.md` 回溯整理的，
> 粒度为「主要能力」而非逐条提交。

---

## [0.9.0-beta.1] — 2026-09-30 · 内测版

**内测阶段回到 0.x：不承诺 API 与数据稳定** —— 功能、界面与数据库结构都可能随时调整，
历史内容可能被定期重置；服务端与前端 `package.json` 的版本号统一为 `0.9.0-beta.1`。

这一版把项目收敛为**纯自托管**：删掉全部第三方依赖（无第三方人机验证厂商、无短信通道、无外部脚本 / CDN），
并把「入口闸门」换成自托管的邀请码 + 本地挑战。**从此整条链路不需要任何出网请求。**

### Added

- **自托管内测门禁**（`server/src/gate.js`、`web/src/context/GateContext.jsx`、`web/src/lib/gate.js`）：
  - 接口：`GET /api/gate/config`、`POST /api/gate/challenge`、`POST /api/gate/verify`、`POST /api/gate/logout`；
  - 三层结构：内测邀请码（服务端只存 `HMAC-SHA256`，`timingSafeEqual` 比较，过短的码被忽略并警告）
    → 服务端出题的一次性本地挑战（**答案只存在服务端内存**，默认 2 题、10 分钟过期、答对即作废、最多错 5 次，
    挑战绑定访客 IP 哈希）→ HMAC 签名、绑定 IP 哈希、`HttpOnly` + `SameSite=Lax` 的 `od_gate` 会话 cookie；
  - 覆盖所有写操作（发帖 / 评论 / 点赞 / 举报 / 反馈），未过闸门一律 `403 {"error":"gate_required"}`；
  - 新环境变量：`GATE_ENFORCE`、`GATE_INVITE_CODES`、`GATE_TTL`(43200)、`GATE_CHALLENGE_TTL`(600)、
    `GATE_CHALLENGE_ITEMS`(2)、`GATE_MAX_ATTEMPTS`(5)、`GATE_COOKIE`(od_gate)、`GATE_COOKIE_SECURE`、
    `GATE_SECRET`、`GATE_ALLOW_DISABLED`。
- **内测反馈**：`POST /api/feedback`（需过门禁，正文 4–800 字，联系方式选填，按 IP 限流 5 次/小时）；
  后台 `GET /api/admin/feedback` 与 `POST /api/admin/feedback/:id/resolve`；
  新表 `feedback` + 索引 `idx_feedback_status`；前端反馈弹层 `web/src/components/FeedbackSheet.jsx`；
  新环境变量 `BETA_FEEDBACK`、`FEEDBACK_EMAIL`、`FEEDBACK_MAX`(800)、`FEEDBACK_KEEP`(2000)。
- **内测版元信息由服务端下发**（`server/src/beta.js`）：`BETA_VERSION`、`BETA_NAME`、`BETA_NOTICE`，
  前端只保留兜底默认值（`web/src/lib/beta.js`）—— 改公告文案不必重新构建前端。
- **内测版 UI**：顶部内测标识条 `BetaBanner.jsx`（版本徽标 + 内测说明 / 内测反馈 / 输入邀请码三个入口）、
  首屏内测公告 `BetaNotice.jsx`（关闭状态按**版本号**记在 `localStorage`，换版本会重新出现）、
  门禁弹层 `GateSheet`、以及 `web/src/styles/beta.css`。
- **审核后台升级为 v2.1.0 的控制台版本**（`server/public/admin.html`，单文件零构建，`GET /admin` 由后端直出）：
  导航为「概览 / 待审队列 / 举报工单 / 审核日志 / 内测反馈」，支持关键词搜索、批量通过/驳回/下架、
  帖子详情、审核日志，以及**无后端演示模式**。
- **新增 / 增强的管理接口**：`GET /api/admin/queue`（`type/cursor/q/total/nextCursor`）、
  `GET /api/admin/posts/:id`（正文 + 全部评论 + 相关工单）、`POST /api/admin/bulk`（一次事务处理多条）、
  `GET /api/admin/audit`（留痕，**不返回 `ip_hash`**）、增强的 `GET /api/admin/reports`（LEFT JOIN 带出被举报内容）；
  `GET /api/admin/stats` 新增 `pendingTotal`、`oldestPendingAt`、`generatedAt`、`openFeedback`、
  `gateRequired`、`gateInviteRequired`、`betaVersion`；恢复 `POST /api/admin/shutdown`（受控优雅停机）。
- **合规预筛增强**（`server/src/moderation.js`）：匹配前做 Unicode NFKC 归一化 + 去除零宽字符；
  手机号 / 学号 / 社交账号 / 身份证类规则额外在「紧凑形态」（去掉空白与分隔符）上匹配一次；
  `banned.txt` 词表按 mtime 热重载（`BANNED_RELOAD_MS`，默认 30 秒，`0` 关闭）。
- **响应压缩优化**：从 gzip 升级为 **br 优先 + gzip-6 兜底**，并新增按 etag 缓存压缩结果的内存缓存
  （静态产物只压一次；上限 64 条 / 8MB；响应体 ≥1KB 才压）。质量档自适应：静态产物 < 64KB 用 `q11`、
  更大的用 `q9`，动态 JSON 用 `q5` —— 实测 br 默认档 4 反而比 gzip-6 大 1%–7%，因此不能沿用默认档。
- **测试**：新增 `server/scripts/gate-test.js`（按环境变量**分档**启动真实服务进程，覆盖门禁关闭/开启、
  会话绑定与过期、答错上限、先审后发链路、反馈链路、生产守卫、限流档）；
  `server/package.json` 的 `test` 串跑 `api-test.js && gate-test.js && db-check.js`，
  并新增 `test:api` / `test:gate` / `test:db` / `db:check` / `db:recount`。
- **面板 / 容器部署支持（没有 shell 的主机）**：
  - `server/src/env.js`：零依赖读取 `server/.env`（**已存在的环境变量优先**，与 `--env-file` 语义一致），
    Pterodactyl / Wispbyte 这类「启动命令固定为 `node ${JS_FILE}`、开不了 shell」的主机因此能配环境；
    `OD_SKIP_ENV_FILE=1` 可关闭，三个测试脚本默认带上它 —— 免得开发机上那份 `.env` 悄悄改变测试结果；
  - `PORT` / `HOST` 缺省时自动采用面板注入的 `SERVER_PORT` / `SERVER_IP`（面板分配的端口是动态的）；
  - `scripts/prepare.mjs`（挂在根 `package.json` 的 `prepare` 钩子）：`npm install` 之后自动
    **安装后端依赖并构建前端** —— 面板只会跑这一条命令，这一步让它能直接跑到可用状态；
    构建失败、缺 vite、装依赖失败都只警告不阻断，避免「装不上 → 起不来」的死循环；
  - 服务端启动时若 `WEB_ROOT` 下没有入口文件会明确告警（面板部署最容易漏的一步）。
    部署步骤见 `DEPLOY.md` §5.5。
  - **绕过 npm 12 的安装脚本封锁**：npm 12 起默认不执行依赖的安装脚本（供应链加固），
    而 better-sqlite3 的原生二进制要靠它的 `install` 脚本（`prebuild-install`）才能就位 ——
    表现是包"装好了"但运行时 `Could not locate the bindings file`。
    `.npmrc` 与 `server/.npmrc` 显式放行 `better-sqlite3` / `esbuild`；
    同时 `scripts/prepare.mjs` 会在安装后**自检二进制是否存在**，缺失就自己补跑
    `prebuild-install`（下载预编译包），失败再回退 `node-gyp rebuild`（现场编译）。
    这让部署不依赖任何特定 npm 版本的策略。

### Changed

- **评论改为与帖子同口径的先审后发**：帖子和评论都一律写入 `pending`，人工审核通过后才公开
  （旧行为是「评论命中规则才转人工、否则直接公开」，属于发布后审核）；`comments.status` 的默认值
  也从 `approved` 修正为 `pending`。
- **点赞/评论计数与审核动作对齐**：评论通过时 `comment_count` +1，把**已通过**的评论驳回时 −1
  （`MAX(0, …)` 兜底），并让信息流缓存立即失效。
- **静态缓存策略分层**：带内容哈希的产物 → `Cache-Control: public, max-age=31536000, immutable`；
  HTML → `no-cache` + `ETag`；无指纹静态资源 → `86400`。
- **连接层调优**：`keepAliveTimeout=65s`（高于常见反代 60s，避免偶发 502）、
  `headersTimeout=66s`、`requestTimeout=30s`。
- **前端构建**：目标从 `es2019` 提到 `es2020`、关闭 modulePreload polyfill、
  把 React 拆成独立 `vendor` chunk —— 发版时老用户只需重新下载应用 chunk。
- **内测版页面加 `noindex, nofollow`**（含构建产物 `web/dist/index.html`）。
- **systemd 单元**：明确「内测门禁不出网」，说明保留 `AF_INET` 只为 DNS / 校时；
  数据目录通过 `ReadWritePaths` 限定为 `server/data`。
- **文档重写**：`README.md`、`DEPLOY.md`、`server/README.md`、`DESIGN.md` 按内测版现状更新，
  新增 `CHANGELOG.md`（本文件）。

### Removed

- **Cloudflare Turnstile 全套**：`server/src/challenge.js`、`web/src/lib/turnstile.js`、
  `web/src/components/Turnstile.jsx`、`web/src/context/ChallengeContext.jsx`、
  `web/src/styles/challenge.css` 全部删除；`/api/challenge/*` 路由消失；
  `TURNSTILE_*`、`CHALLENGE_*`、`VITE_CHALLENGE_TEST_MODE` 作废。
- **手机号实名与短信全套**：`server/src/identity.js`、`server/src/sms.js`、
  `web/src/context/IdentityContext.jsx`、`web/src/lib/identity.js`、
  `server/scripts/identity-test.js` 全部删除；`identities` / `identity_codes` 两张表与
  `posts` / `comments` / `reports` 的 `identity_id` 列从 `schema.sql` 移除；
  `IDENTITY_*`、`SMS_*`、`TWILIO_*` 作废；后台不再有实名面板与身份追溯视图。
  **内测阶段不收集手机号、没有账号体系**；需要恢复时从 git 历史取回：
  `git log --oneline -- server/src/identity.js`（`bd5d85e`）、
  `git log --oneline -- server/src/challenge.js`（`ebb0c36`）。
- 后台旧版「四个工作区」（帖子 / 评论 / 工单 / 身份）的界面与相关接口。

### Fixed

- **缺省 `limit` 被吞成 0 的分页 bug**：`Number(null) === 0` 让「不传 `limit`」变成「只要 1 条」，
  首屏一度只返回一条内容。`server/src/server.js` 的 `toInt()` 现在显式挡住 `null` / 空串再走 fallback，
  `api-test.js` 加了回归断言。
- **`comment_count` 单向上漂**：驳回已通过的评论时计数只增不减 → 现在随审核动作增减。
- **`comments` 表默认状态与写入路径不一致**（`DEFAULT 'approved'`）→ 修正为 `pending`。
- **示例值里的占位符邀请码会被误当成真码**：`server/.env.example` 的
  `change-me-at-least-8-chars` 有 26 位、能通过长度校验 —— 照抄的人会拿到一个
  「写在公开仓库里、人人皆知」的邀请码，而启动日志还显示「邀请码 已配置」。
  现在常见占位符（`change-me*`、`your-invite-code`、`test-code` 等）一律被拒绝，
  生产环境因此走到「未配置 → 拒绝启动」，属于大声失败。
- **`GATE_COOKIE_SECURE=0` 在生产不生效**：原来的 `=== '1' || IS_PROD` 让 `Secure` 恒为真，
  纯 HTTP 内网部署下浏览器会丢弃会话 cookie，用户陷入「刚验证完又要求验证」的死循环
  （只在非 localhost 的 HTTP 地址上暴露，本机验收看不出来）。现在显式 `0` 可以覆盖，
  并在启动时打一条安全警告。实测对照见 `DEPLOY.md`。
- **两个 lockfile 里被误改的依赖版本**：批量改版本号时把 `convert-source-map`（2.0.0）、
  `file-uri-to-path` / `fs-constants`（1.0.0）的 `version` 一起改写成了 `0.9.0-beta.1`。
  `npm install` 已把它们修回真实版本，两个 lockfile 现在与 `resolved` URL 完全一致。
- **`prod-e2e.mjs` 造数据子进程的偶发 134**：Windows + 管道 stdout 下，better-sqlite3 的
  Statement 析构会晚于环境拆除（`Assertion failed: (env) != nullptr`）。改为「结果落盘标记文件 +
  硬退出」，父进程按标记文件判定成功，不再看退出码（同款处理见 `server/scripts/db-check.js`）。
- 旧库升级的兼容性：新增**尽力而为的幂等迁移**（见下）。

### Security

- **CSP 收紧到纯自托管**：`default-src 'self'`、`script-src 'self' 'unsafe-inline'`、
  `frame-src 'none'`、`connect-src 'self'`、`base-uri 'none'`、`frame-ancestors 'none'`；
  页面不再加载任何第三方脚本 / iframe / Web Font。
- **生产环境未配置 `GATE_INVITE_CODES` 时拒绝启动**（打印原因并以退出码 1 退出），
  除非显式设置 `GATE_ALLOW_DISABLED=1`；`ADMIN_TOKEN`（≥24 字符）与 `IP_HASH_SECRET`（≥16 字符）
  在 `NODE_ENV=production` 下同样是硬性要求。
- 门禁会话与挑战都在进程内存中、答案不下发、挑战一次性且绑定 IP 哈希；
  邀请码与令牌均使用常量时间比较。
- 审核留痕接口不再返回 `ip_hash`；后台界面也不把任何哈希渲染进 DOM。
- 限流细化：写操作按端点限流（发帖 3/10min、评论 20/5min、点赞 120/5min、举报 10/h、反馈 5/h），
  门禁出题 30/10min、校验 20/10min，管理鉴权 `ADMIN_RATE_LIMIT`(10)/15min。

### 升级与回滚注意

- **旧库升级**：`server/src/db.js` 启动时做幂等迁移 —— 删除实名时代的索引与
  `identities` / `identity_codes` 表，并尝试 `ALTER TABLE … DROP COLUMN identity_id`；
  **删不掉就保留为空列，代码不再读写**，绝不会因为清理失败导致服务起不来（迁移日志会写明结果）。
  **`DROP TABLE identities` 不可逆**，回滚到 v2.1.0 之前请先备份数据库。
- **版本号方向**：`0.9.0-beta.1` 低于 `2.1.0`，这是刻意的（内测回到 0.x）。
  **不要用版本号大小判断新旧**，一律以 commit / tag 为准。
- 前端可独立回滚（后端 API 未变时）：`git checkout <上一个可用 commit> -- web/ index.html && VITE_DATA_MODE=api npm run build`。

---

## [2.1.0] — 2026-09-27

> 依据 git 提交 `bd5d85e`（feat: 后台实名（手机号验证）+ 先审后发 + 审核后台）整理。

### Added

- 后台实名（手机号 + 短信验证码）：写操作前强制验证，`identities` / `identity_codes` 表，
  只存手机号的 HMAC-SHA256 与脱敏形式（`86 13****00`）；可插拔短信通道（`log` / `webhook` / `twilio`）。
- 管理端「实名身份」视图与按身份追溯能力（反查该号码发布过的全部内容，含待审与已下架）。
- 审核后台的单帖详情、审核意见与更完整的工单处理流程。

### Changed

- **先审后发**：帖子与评论进入待审队列，人工通过后才公开；规则命中只作为复核信号。

---

## [2.0.0] — 2026-09-27

> 依据 git 提交 `ebb0c36`（feat: 校园表白墙 —— React 前端 + Node/SQLite 后端 + Turnstile 人机验证）整理。

### Added

- React（Vite）前端 + Node 内置 `http` + SQLite(WAL) 后端的第一版工程化实现；
  前台包含表白 / 树洞 / 寻人 / 失物 / 致谢分类、发布抽屉、点赞、评论、举报与发布公约。
- Cloudflare Turnstile 人机验证（服务端 Siteverify + 短期会话 cookie）作为写操作闸门。
- 进程内限流、合规预筛（联系方式与起底特征规则）、审核后台单文件页面、keyset 分页与
  信息流短时缓存等低配 VPS 优化。
- 零依赖的端到端测试脚手架（无头浏览器 + CDP）与设计令牌一致性脚本。
