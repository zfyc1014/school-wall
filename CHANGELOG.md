# 更新日志

本文件记录校园墙的版本变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 说明：仓库在 `0.9.0-beta.1` 之前没有 `CHANGELOG.md`，因此 `2.0.0` 与 `2.1.0` 两条
> 是依据 git 历史（`ebb0c36`、`bd5d85e`）与当时的 `README.md` / `DEPLOY.md` 回溯整理的，
> 粒度为「主要能力」而非逐条提交。

---

## [1.0.0] — 2026-10-16 · 正式版

**从内测转正式：引入账号体系，删掉全部内测与示例内容。** 版本号统一为 `1.0.0`。

这一版的核心变化是「有身份」：表白墙依旧是匿名的，但发帖的人有账号、有学校、有头衔与等级，
并且能在论坛里署名讨论、加好友、私信。同时把内测期所有临时设施（邀请码门禁、内测标识、
本地演示数据、单文件原型）整体删除。

### Added

- **账号系统**（`server/src/users.js`）：邮箱验证码登录（无密码）、`uuid` 作为对外唯一标识、
  会话 cookie（HttpOnly + SameSite=Lax，token 只存 SHA-256）。
- **Cloudflare Email Service 发信**（`server/src/email.js`）：走 REST 接口
  `POST /accounts/{id}/email/sending/send`；未配置凭据时降级为服务端日志 + `server/data/outbox/`，
  且只在非生产环境回带验证码。部署文档给出 `wrangler email sending enable` 的准备步骤。
- **昵称本地预审**（`moderation.classifyNickname`）：命中违禁词、联系方式、冒名官方（管理员/客服/官方…）
  **直接拒绝注册或改名**；内容侧仍保持「命中转人工」。
- **论坛**（`server/src/forum.js` + `web/src/forum/`）：四个版块、主题/回复/点赞；
  **署名展示「学校 · 头衔 · Lv.N」**；默认「命中预筛才转人工」，`FORUM_PREMOD=1` 可切回全量先审。
- **好友与私信**（`server/src/social.js` + `web/src/social/`）：请求—同意式加好友
  （互相添加即刻成为好友）、拉黑（解除好友 + 拒收私信）、会话列表与未读红点、单聊。
- **头衔与等级**：头衔由后台自定义（名称/颜色/是否按等级自动授予），手动指定优先；
  等级由经验推导（L2=50、L3=150、L4=300…），来源为发帖、评论、被点赞与每日登录。
- **首页公告栏**（`server/src/announce.js`）：后台增删改与启停，前端通过 `GET /api/site` 获取。
- **学校管理**：改由后台维护（数据库表 `schools`，不再用文件生成）；
  **登录时强制选择学校，选定后不可更改**，并显示在用户主页最前面。
- **后台新增视图**：用户（完整信息 + 设头衔/等级/经验/改名/封禁）、头衔、公告、学校；
  待审队列扩展为「帖子 / 评论 / 主题 / 回复」四类。

### Changed

- **界面重构为移动优先**：主界面只保留站名、公告、分类与信息流；
  底部 dock 改为**液态玻璃**（半透明 + 模糊饱和 + 内高光），新增深色模式（跟随系统）。
- **取消表白正文字数上限**：只要求非空，长文在信息流里默认折叠 8 行。
- 点赞去重主体从「IP 哈希」升级为「登录用户」（`likes.ip_hash` → `likes.actor`），
  换设备仍是同一个人。
- 前端不再有任何本地演示数据与数据源回落：只连真实后端。

### Removed

- **内测门禁整体删除**：`server/src/gate.js`、`web/src/context/GateContext.jsx`、`web/src/lib/gate.js`
  与 `GATE_*` 全部配置项。
- **内测标识与元信息**：`server/src/beta.js`、`BETA_*` 配置、首屏内测公告与版本横幅。
- **示例与演示内容**：单文件原型 `school-confession-wall.html`（及其 artifact 清单）、
  本地演示数据 `web/src/lib/seed.js`、`server/data/banned.txt.example`、旧截图，
  以及库里遗留的实名时代表（`identities` / `identity_codes`）。
- 「内测反馈」更名为「意见反馈」（功能保留）。

### Migration

- 旧库（0.9）可直接升级：启动时自动补 `posts.user_id` / `comments.user_id` /
  `reports.reporter_id` / `feedback.user_id` 列，重命名 `likes.ip_hash → actor`，
  并清理实名时代遗留对象；历史内容没有作者，留空即可（前台本来也不展示作者）。
- 升级后请到后台补两件事：**添加学校名单**、配置 **Cloudflare 邮件通道**。

### 追加 · Brevo 双通道验证码（邮件 + 短信）（可选功能）

> 仍属 v1.0.0 交付范围。不配置 `BREVO_*` 时行为与之前完全一致（邮件仍可走 Cloudflare 或降级日志）。

- **发信通道可插拔**（`server/src/email.js`）：`brevo` / `cloudflare` / `log` 三选一，由
  `MAIL_PROVIDER` 决定（默认 auto：Brevo 配好优先用 Brevo）。已配 Cloudflare 的部署不必迁移。
- **短信通道**（`server/src/sms.js` + `server/src/brevo.js`）：Brevo v3 `/transactionalSMS/sms`；
  短信文案按中文 70 字内设计，避免按多条计费。
- **手机号登录**：`users.phone`（E.164，唯一部分索引）+ 绑定流程
  （`POST /api/me/phone/code` / `verify` / `DELETE /api/me/phone`）。
  登录接口 `/api/auth/code` 与 `/api/auth/verify` 同时接受 `{email}` 或 `{phone}`。
- **防刷设计**：未绑定号码不发短信（防短信费被刷）；手机号发码同样过人机验证；
  重发间隔只统计**未消费**的验证码 —— 刚验证成功的用户不会被自己的成功操作挡住。
- **Brevo 错误翻译**（`explain()`）：401「IP 不在授权名单」、sender 未验证、额度不足
  都翻成「该去后台改哪里」，并在后台「邮件/短信自检」里原样展示。
- 后台新增 `POST /api/admin/sms/test`，并让 `/api/admin/stats` 返回邮件 provider 与短信就绪状态。
- 新增 `server/scripts/brevo-test.js`（42 项，mock 掉 Brevo API）：邮件/短信发送参数、
  错误降级、手机号归一化、绑定/重复绑定、未绑定不发短信、双通道登录、后台自检、未配置关闭。

### 追加 · Cloudflare Turnstile 人机验证（可选功能）
<span id="turnstile"></span>

> 同日追加，仍属于 v1.0.0 的交付范围（版本号不单独提升）。
> 只保护「发送登录验证码」一个入口 —— 全站唯一会对外发信、也是注册漏斗第一道门；
> 表白/论坛的写入已有「先审后发 + 限流」兜底，不需要每个动作都弹人机验证。
> **不配置就完全不生效**，登录流程与之前完全一样。

- **前端**（`web/src/lib/turnstile.js` + `components/Turnstile.jsx`）：按需加载 `api.js`（显式渲染），
  只在登录弹层里出现，不拖累首屏；每次请求后 reset 换新 token（token 一次性）。
- **服务端**（`server/src/turnstile.js`）：canonical siteverify，**同时校验 action 与 hostname 白名单** ——
  只校验 `success` 等于允许别的站点签发的 token 来打我们的发码接口；失败 fail-closed，
  Cloudflare 不可达返回 503 而不是放行。
- **CSP** 只开三个口子（script / frame / connect 指向 `challenges.cloudflare.com`），其余仍收紧到 `'self'`。
- 新增 `server/scripts/turnstile-test.js`（19 项，mock 掉 siteverify）：缺 token / 校验失败 /
  action 不匹配 / hostname 不匹配 / siteverify 5xx / 白名单为空 / 正常发码 / 请求参数形状；
  `scripts/turnstile-live-check.mjs` 是手动连通性诊断（需外网与真实 key）。
- 部署注意：widget 的 **Hostname Management** 必须包含正式域名（本地开发再追加 `localhost`）。

### 追加 · 爱发电赞助接入（可选功能）
<span id="afdian"></span>

> 同日追加，仍属于 v1.0.0 的交付范围（版本号不单独提升）。
> 接上爱发电之后，赞助会自动记录、按留言匹配到本站账号，并按金额分档自动发头衔。
> **不配置就完全不生效** —— 接口 404、App 不显示入口，其余功能不受影响。

#### 新增

- **赞助回调** `POST /api/afdian/webhook`：
  - 签名照官方算法 `md5(token + "params" + params + "ts" + ts + "user_id" + user_id)`，定长比较；
    `AFDIAN_TOKEN` 未配置时拒绝一切回调 —— 否则任何人都能伪造一笔赞助来骗头衔；
  - 兼容 form-urlencoded（`params=<JSON>&sign=<md5>`）与 JSON 两种报文形态；
  - 回 `{"ec":200,"em":""}`，否则平台会按自己的节奏重试。
- **幂等发奖**：`out_trade_no` 唯一约束，重试退化成一次 `INSERT OR IGNORE`，绝不重复发奖。
- **按金额分档自动发奖**（`AFDIAN_REWARD_TIERS`，默认 `5:股东;10:@custom`，无需任何人工审批）：
  ≥5 元得固定头衔「股东」；≥10 元得**留言里自定义**的头衔（`头衔：想要的名字`）。
  只改这一行配置就能加档。
- **账号匹配**：下单留言里的 uuid 或注册邮箱；App 的「支持校园墙」给出一段可直接复制的留言模板。
  漏填留言的订单进后台待绑定队列，可手动认领。
- **自定义头衔要过与昵称相同的预审**（违禁词 / 联系方式 / 冒名官方）——
  否则花 10 元就能叫「管理员」；不合格自动回落到低一档，并在订单上记录原因。
- **管理员手动指派的头衔不被赞助覆盖**，赞助头衔之间可以逐档升级（5 元 → 10 元）；
  判定依据是订单上记录的 `title_id`。
- **后台「赞助」视图**：订单列表与筛选（全部/待绑定/已绑定）、手动绑定与忽略、手动补单
  （调 `query-order`）、回调排查（最近 20 次尝试含被拒原因与原文截断）、回调地址一键复制。
- **App 入口**：「我的 → 支持校园墙」，把 uuid 摆在最显眼处并给一键复制，
  并说明「也可以用注册邮箱」—— 爱发电订单不带邮箱，留言是唯一能把订单和账号连起来的东西。
- 可选经验奖励 `AFDIAN_REWARD_EXP`（默认 0：等级尽量由内容决定，不因赞助而变）。

#### 变更

- `GET /api/site` 新增 `afdian.page`（未配置时为 `null`）。
- 测试：新增 `server/scripts/afdian-test.js`（29 项断言，签名在测试里独立实现一遍，
  避免「用自己证明自己」），已接入 `npm test` 与 `npm run verify`。
- `db-check` 改为「父进程调度 + 子进程体检」：better-sqlite3 在进程拆卸阶段有约一半概率
  触发原生断言（SIGABRT/134），那是退出阶段的问题，不该让 `npm run verify` 随机失败。

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
- **审核后台升级为 v2.1.0 的控制台版本**（`server/public/admin.html`，单文件零构建，`GET /houtai/` 由后端直出）：
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
  **新增 `server/scripts/route-sweep.js`（路由巡检）**：从 `server.js` 解析出全部注册路由，
  在真实服务上逐条打一遍，只断言「没有 5xx」—— 给没人写过断言的路由兜底
  （点赞接口 500 就是这么漏过去的）；
  `server/package.json` 的 `test` 串跑 `api-test.js && gate-test.js && route-sweep.js && db-check.js`，
  并新增 `test:api` / `test:gate` / `test:sweep` / `test:db` / `db:check` / `db:recount`。
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
- **后台页面迁到 `/houtai/`，老地址 `/admin` 变成钓鱼页**：`GET /houtai`、`/houtai/`、
  `/houtai/index.html` 由后端直出 `server/public/admin.html`；`GET /admin`、`/admin/`、`/admin.html`
  返回一张静态页面（HTTP 200，正文只有一句「你以为我会傻到这种程度？」，**不含控制台结构，
  也不含 `ADMIN_TOKEN`**，实现见 `server/src/server.js` 的 `DECOY_HTML` + `serveStatic`）。
  这是**降噪**而非安全措施 —— 真正的防线仍是「`ADMIN_TOKEN` 校验 + 反代层限制来源」。
  `/api/admin/*` 接口路径没有变。

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
- **门禁会话 cookie 的 `Secure` 改为跟随请求协议（auto）**：`GATE_COOKIE_SECURE` 留空时
  HTTPS 请求带 `Secure`、HTTP 请求不带；`=1` 强制带、`=0` 强制不带（生产下仍会打安全警告）。
  启动日志会写明当前模式（`cookie Secure 跟随协议` / `cookie 强制 Secure` / `cookie 不带 Secure`），
  见 `server/src/gate.js` 的 `COOKIE_SECURE_MODE` / `cookieSecure()`。
- **站点文案按「去 AI 味」重写，并删掉与本站不符的内容**：
  `web/src/components/LegalSheet.jsx` 从「免责声明与发布公约」重写为**发布公约**，
  只讲本站真正做的事（别发这些 / 发出去之后 / 被举报了会怎样 / 未满 18 岁 / 内测期间），
  删掉香港法例清单、UGC、律师审阅与模板版本号；`web/src/components/Footer.jsx` 不再写
  「内容为用户生成内容（UGC）」，法律链接改为发布公约 / 举报与处理 / 隐私说明；
  `web/src/App.jsx` 的首屏与 CTA 改成口语化表述。
  **`school-confession-wall.html`（原始单文件原型）刻意未改** —— 它仍是视觉基线与
  `scripts/check-tokens.py` 的令牌契约来源，其中的法律文案属于历史原型，不代表线上站点。

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
  （后续进一步改成「默认跟随请求协议」，见 Changed 里对应的一条：纯 HTTP 部署不再需要手工设 `0`。）
- **两个 lockfile 里被误改的依赖版本**：批量改版本号时把 `convert-source-map`（2.0.0）、
  `file-uri-to-path` / `fs-constants`（1.0.0）的 `version` 一起改写成了 `0.9.0-beta.1`。
  `npm install` 已把它们修回真实版本，两个 lockfile 现在与 `resolved` URL 完全一致。
- **`prod-e2e.mjs` 造数据子进程的偶发 134**：Windows + 管道 stdout 下，better-sqlite3 的
  Statement 析构会晚于环境拆除（`Assertion failed: (env) != nullptr`）。改为「结果落盘标记文件 +
  硬退出」，父进程按标记文件判定成功，不再看退出码（同款处理见 `server/scripts/db-check.js`）。
- 旧库升级的兼容性：新增**尽力而为的幂等迁移**（见下）。
- **点赞接口在真实后端上一直是 500**：`POST /api/posts/:id/like` 里的
  `SELECT 1 AS on FROM likes …` 把 SQL 保留字 `ON` 当成了列别名，每次点赞都
  `SqliteError: near "on": syntax error`（服务端只留一行 `[error]`，前端表现为点了没反应）。
  长期没被发现是因为**这条链路从来没被测过**：`smoke.mjs` 跑本地演示模式、
  `api-smoke.mjs` 用它自带的 mock 后端，两者都不经过真实处理器；`prod-e2e.mjs` 也没点过赞。
  现在 `api-test.js` 补了点赞全链路断言：待审帖子点赞 404 → 管理接口通过 → 点赞 `{liked:true,likes:1}`
  → 再点取消 `{liked:false,likes:0}` → 不带会话 403。顺手全仓扫了一遍「SQL 关键字当别名」，无其他命中。
- **后台被自己的限流挡住（页面报 `rate_limited`）**：`requireAdmin` 原来只有一个桶且对
  **所有**管理请求计数，默认 10 次 / 15 分钟 —— 控制台一进页面就打 6 个接口，点几下审核就超，
  于是正常审核变成「等 15 分钟」。现在拆成两个桶：令牌错误 `ADMIN_RATE_LIMIT`（防爆破，行为不变）、
  已鉴权 `ADMIN_API_RATE_LIMIT`（默认 600 / 5 分钟，只防脚本刷库）。`api-test.js` 加了回归断言：
  在 `ADMIN_RATE_LIMIT=3` 下连打 12 次已鉴权请求必须全部 200，而错误令牌仍然 401 → 429。
- **纯 HTTP 部署下「刚验证完又要求验证」的死循环不再需要人工干预**：此前必须记得设
  `GATE_COOKIE_SECURE=0`，漏设就会在非 localhost 的 HTTP 地址上被浏览器丢弃会话 cookie
  （localhost 被当成可信来源，本机验收永远看不出来）。现在默认 auto 跟随协议，纯 HTTP 部署
  **不需要**再手工设 0；前面那条「显式 `0` 可覆盖」的修复仍然有效，只是不再是必需操作。
  HTTP 下的 cookie 与邀请码仍是明文传输，风险提示见 `DEPLOY.md` §5.5。

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
  门禁出题 30/10min、校验 20/10min，管理鉴权分两个桶：
  **令牌错误**的尝试 `ADMIN_RATE_LIMIT`(10)/15min，**已鉴权**请求 `ADMIN_API_RATE_LIMIT`(600)/5min。
  两者混在一起会把后台自己挡住 —— 控制台一进页面就要打 6 个接口（stats + 两个队列 + 工单 +
  审核日志 + 反馈），每次审核动作还会再刷一遍，默认 10 次/15 分钟十几秒就撞上，
  页面开始报 `rate_limited`。后台前端遇到 429 也会直接提示「还要等多久」，不再显示原始错误码。

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