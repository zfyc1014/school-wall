# 校园表白墙 · 内测版 `0.9.0-beta.1`

一个**纯自托管**的校园匿名表白墙：React 前台 + 单进程 Node（`node:http` + SQLite WAL）后端，
**不依赖任何第三方云服务**（无第三方人机验证厂商、无短信通道、无外部 CDN / Web Font），
面向 **1 vCPU / 1GB 内存的最低配置 VPS（香港）** 部署。

> **这是内测版（回到 0.x）**：不承诺 API 与数据稳定 —— 功能、界面与数据库结构都可能随时调整，
> 历史内容可能被定期重置。请不要发布隐私信息，也不要发布无法承受丢失的重要内容。
>
> **内测阶段不收集手机号、没有账号体系**：写操作只需要一枚内测邀请码 + 一道本站生成的本地题目。
> 内容依然是**先审后发**（帖子与评论都要人工通过才公开）。

---

## 1. 架构

```
浏览器（无任何第三方脚本 / iframe）
  │  HTTPS
  ▼
Caddy（自动 HTTPS、静态资源直发）──────────► web/dist 静态产物
  │  reverse_proxy 127.0.0.1:8080
  ▼
Node 后端（单进程，server/src/server.js）
  ├─ /api/*            业务 API：先审后发 · 进程内限流 · 合规预筛
  ├─ /api/gate/*       内测门禁：邀请码 + 一次性本地挑战 + HMAC 会话（全程不出网）
  ├─ /api/feedback     内测反馈（只进后台队列，不公开）
  ├─ /houtai/          审核后台（单文件 server/public/admin.html，后端直出；老地址 /admin 是钓鱼页）
  └─ SQLite（WAL）      server/data/wall.db（无独立数据库进程）
```

| 组件 | 技术 | 为什么适合低配 VPS |
| --- | --- | --- |
| 前端 | Vite 5 + React 18，构建到 `web/dist/` | 产物拆分 vendor / app，静态托管即可 |
| 后端 | Node 内置 `http`，无框架 | 常驻内存小、冷启动快、依赖只有 `better-sqlite3` |
| 存储 | SQLite（WAL，单文件） | 省掉一整份数据库服务的内存与运维 |
| 人机/入口闸门 | **自托管**（`server/src/gate.js`） | 不出网、离线可部署、失败模式为零 |
| 反向代理 | Caddy（或 Nginx） | 低配机器不承担 TLS 握手 CPU |

### 目录说明

| 路径 | 说明 |
| --- | --- |
| `web/` | React 源码（Vite 工程）；`web/src/styles/tokens.css` 是唯一设计令牌来源 |
| `index.html` | Vite 入口（必须位于 Vite root，即仓库根） |
| `server/` | Node 后端：API、`schema.sql`、限流、合规预筛、内测门禁、审核后台 |
| `server/public/admin.html` | 审核后台（单文件零构建，访问 `/houtai/`；老路径 `/admin` 只返回钓鱼页） |
| `server/.env.example` | **后端环境变量的权威清单**（含默认值与取值范围） |
| `.env.example` / `.env.production.example` | 前端构建期变量（`VITE_*`，会打进产物，禁止放密钥） |
| `school-confession-wall.html` | 原始单文件原型，保留未改动（视觉基线，令牌契约由 `npm run tokens` 校验）；里面的法律文案是**历史原型**，不代表线上站点 |
| `DESIGN.md` | 设计系统契约与组件映射 |
| `docs/design/` | 审核后台的**设计交付件**（`DESIGN-HANDOFF.md` 视觉契约、`DESIGN-MANIFEST.json` 机器可读清单）；改后台界面前先读，别把定稿的排版与状态改回通用卡片 |
| `CHANGELOG.md` | 更新日志（Keep a Changelog 结构；内测阶段版本回到 `0.x`，不承诺 API 与数据稳定） |
| `DEPLOY.md` | **上线配置与运维手册（先读这个）** |
| `scripts/` `server/scripts/` | 端到端测试与数据库自检（零测试框架依赖） |

---

## 2. 三条命令

```bash
npm install          # 前端依赖（react / react-dom / vite）
npm run dev          # 开发预览 → http://127.0.0.1:5173
npm run build        # 生产构建 → web/dist/
```

> **Windows 提示**：本机 PowerShell 执行策略会禁止运行 `npm.ps1`。
> 用 `cmd /c "npm run dev"`（或在 cmd 里执行），不要为此改执行策略。

---

## 3. 前后端一起跑（真实数据）

```bash
# 终端 A —— 后端
cd server
npm install
cp .env.example .env          # 至少改 ADMIN_TOKEN / IP_HASH_SECRET
node src/server.js            # 监听 127.0.0.1:8080
# server/.env 会被自动读取（零依赖，见 server/src/env.js）：
#   - 已经存在的环境变量优先，所以临时覆盖直接写在命令前面即可
#   - Node 20+ 也可以用 `node --env-file=.env src/server.js`，效果一样
#   - 面板/容器部署没有 shell：把配置放进 server/.env 就能跑

# 终端 B —— 前端（仓库根）
npm run dev                            # 5173，/api 自动代理到 8080
```

前端 dev / preview 内置代理，浏览器里 `fetch('/api/…')` 直接命中后端，**同源、无需 CORS**。
后端不在 8080 时用 `OD_API_TARGET=http://127.0.0.1:9000 npm run dev` 覆盖。

数据源模式由前端构建期变量控制（`.env.example`）：

```bash
VITE_DATA_MODE=auto    # 开发预览：优先 /api，失败回落本地演示数据
VITE_DATA_MODE=api     # 生产：强制连后端，连不上直接报错（推荐）
VITE_DATA_MODE=local   # 纯前端演示，完全不请求后端
```

**开发环境默认不需要邀请码**：`NODE_ENV` 不是 `production` 且未配置 `GATE_INVITE_CODES` 时，
内测门禁关闭（启动日志会说明）。想在本地验证门禁：

```bash
GATE_ENFORCE=1 GATE_INVITE_CODES=dev-beta-2026 node --env-file=.env src/server.js
```

生产部署（环境变量逐条、Caddy + systemd、压缩与缓存验证、备份与回滚、故障排查）
全部写在 **`DEPLOY.md`**。

---

## 4. 内测门禁（自托管）

**它是什么**：把站点关在小范围内的一道**服务端强制**闸门，由 `server/src/gate.js` 实现，三层结构：

| 层 | 做法 | 关键取值 |
| --- | --- | --- |
| 内测邀请码 | 人手一份的共享口令；服务端只保存 `HMAC-SHA256`，比较用 `timingSafeEqual`，过短的码（< 8 位）会被忽略并打警告 | `GATE_INVITE_CODES`（逗号或空格分隔，可配多个） |
| 一次性本地挑战 | 服务端出题（两位数加减，默认 2 题），**答案只存在服务端内存**，默认 10 分钟过期、答对即作废、最多错 5 次；挑战与访客 IP 哈希绑定 | `GATE_CHALLENGE_TTL=600`、`GATE_CHALLENGE_ITEMS=2`、`GATE_MAX_ATTEMPTS=5` |
| 短期会话 cookie | HMAC-SHA256 签名、绑定 IP 哈希、`HttpOnly` + `SameSite=Lax`，默认 12 小时；`Secure` **跟随请求协议**（HTTPS 请求带、HTTP 请求不带） | `GATE_COOKIE=od_gate`、`GATE_TTL=43200`、`GATE_COOKIE_SECURE`（留空 = auto；`1` 强制带、`0` 强制不带） |

接口（全部在本进程内完成，无任何出网请求）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/gate/config` | 是否强制、是否需要邀请码、当前会话是否已通过、内测版元信息 |
| `POST` | `/api/gate/challenge` | 取一份一次性挑战题目（只下发题面，不下发答案） |
| `POST` | `/api/gate/verify` | `{code, challengeId, answers[]}` → 通过则 `Set-Cookie` 签发会话 |
| `POST` | `/api/gate/logout` | 结束会话（同一台设备换人使用时用） |

**覆盖范围**：所有**写操作**（发帖 / 评论 / 点赞 / 举报 / 反馈）。未过闸门时服务端直接返回
`403 {"error":"gate_required"}` —— 不依赖前端按钮，`curl` 也绕不过去。

**生产拒绝裸奔**：`NODE_ENV=production` 且未配置 `GATE_INVITE_CODES` 时，服务**拒绝启动**
（打印原因并以退出码 1 退出）。确有临时需要时用 `GATE_ALLOW_DISABLED=1` 显式放行。

### 为什么不用第三方人机验证（取舍说明）

v2.1.0 用的是 Cloudflare Turnstile，这一版把它**整体删除**，换成上面这套自托管方案。
取舍是明确的，两边都有代价：

- **换来的是**：① 零出网依赖 —— 校验全在本进程内完成，没有「验证服务不可达」这种失败模式，
  也不需要为它设计 fail-open/fail-closed；② 零第三方数据处理 —— 不再向境外厂商回传访客 IP，
  隐私政策里少一个第三方，CSP 可以从「放行两个外部来源」收紧到 `script-src 'self'`、
  `frame-src 'none'`；③ 离线可部署 —— 内网、无外网出口的机器照样能跑。
- **放弃的是**：Turnstile 背后是 Cloudflare 的威胁情报与大规模风控模型，**这一点自建方案替代不了**。
  两位数的加减题拦不住针对性写脚本的人，它只能拦掉「随手写的批量刷屏」。
- **因此真正的防线不是这道题**，而是三件事叠加：**进程内限流**（写接口按 IP 哈希限流）+
  **先审后发**（没有人工审核，任何内容都不会公开）+ **邀请码把受众关在小范围**。
  低配机器上这套组合的成本也比「每次写请求都要过一次外部风控」低得多。
- **如果将来要接回第三方验证**：Turnstile 的实现可从 git 历史取回 ——
  `git log --oneline -- server/src/challenge.js`（原始提交 `ebb0c36`）。

---

## 5. 内测反馈

内测阶段最重要的输入渠道。前端有两个入口：顶部内测标识条的「内测反馈」与页脚的「内测反馈」，
打开的是 `web/src/components/FeedbackSheet.jsx` 弹层（分类：功能异常 / 改进建议 / 其它，
正文 4–800 字，**联系方式选填** —— 不留也能提交）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/feedback` | `{cat, body, contact?}`；**需过门禁**；按 IP 哈希限流 5 次/小时 |
| `GET` | `/api/admin/feedback?status=open\|done\|dismissed\|all&limit=` | 后台反馈队列（需鉴权） |
| `POST` | `/api/admin/feedback/:id/resolve` | `{"action":"done"\|"dismiss"}` 处理后归档 |

反馈只进后台队列，**不会出现在公开列表里**，因此不做内容预筛。
`BETA_FEEDBACK=0` 可整体关闭入口（此时 `POST /api/feedback` 直接 `403 feedback_disabled`）。
保留策略：默认最多留 `FEEDBACK_KEEP=2000` 条，超出后只清理**已处理**的反馈，待处理的永不自动删除。

相关变量（详见 `server/.env.example`）：`BETA_VERSION`、`BETA_NAME`、`BETA_NOTICE`、
`BETA_FEEDBACK`、`FEEDBACK_EMAIL`、`FEEDBACK_MAX`、`FEEDBACK_KEEP`。

> 内测版元信息（版本号、标识、首屏公告、反馈开关）由服务端下发（`server/src/beta.js`），
> 前端不再硬编码 —— 改文案只需改环境变量后重启，不必重新构建前端。

---

## 6. 审核后台 `/houtai/`

由后端直接提供的**单文件零构建**后台（`server/public/admin.html`），导航为五个工作区
（以文件为准）：

| 工作区 | 做什么 |
| --- | --- |
| **概览** | 待办计数、最久等待时长、数据库体积/WAL/可回收空间、门禁与内测版本状态、最近审核 |
| **待审队列** | 帖子与评论的待审列表：关键词搜索、逐条通过/驳回、批量通过/驳回/下架、查看帖子详情 |
| **举报工单** | 通知—移除流程：直接看到被举报正文与上下文，可下架内容或驳回工单 |
| **审核日志** | `audit_log` 留痕（谁在什么时候做了什么），**不返回 ip_hash** |
| **内测反馈** | 反馈队列三态（open / done / dismissed），处理后归档 |

它自身用 `ADMIN_TOKEN` 调管理接口（令牌只存在本机浏览器 `localStorage`），
**页面不设登录墙 —— 因此必须在反代层限制来源**，推荐 SSH 隧道：

```bash
ssh -L 8080:127.0.0.1:8080 user@your-vps   # 然后本机打开 http://127.0.0.1:8080/houtai/
```

另有**无后端演示模式**：打不开后端时自动进入演示数据（连接状态会显示「演示模式」），
所有操作只在本页生效，可直接用来演示审核流程或做前端联调。

### 老地址 `/admin` 现在是钓鱼页（降噪，不是安全措施）

`GET /admin`、`/admin/`、`/admin.html` 一律返回一张静态页面（HTTP 200），正文只有一句
「你以为我会傻到这种程度？」，**不含控制台的任何结构，也不含 `ADMIN_TOKEN` 字样**
（实现见 `server/src/server.js` 的 `DECOY_HTML`）。扫描器、好奇的路人和拿着旧书签的人
都只会看到这句话。

这个定位要说清楚：它**只是降噪**，把无关流量从后台入口引开，让日志与注意力干净一点，
**不是安全措施** —— 换个路径并不会让后台变安全。真正的防线是两条，缺一不可：

1. 所有 `/api/admin/*` 都强制 `ADMIN_TOKEN` 校验（常量时间比较 + 单独限流）；
2. **反代层限制来源**（推荐 SSH 隧道，别把后台暴露在公网）。

`/api/admin/*` 这些**接口路径没有变**，改的只是后台页面地址与运维约定。

---

## 7. 先审后发与合规预筛

**帖子与评论都一律先进入 `pending`**，人工审核通过后才公开。不接受「发布后审核」或「只靠举报」。

| 内容 | 默认状态 | 公开条件 |
| --- | --- | --- |
| 帖子 | `pending` | 管理员 `approve` 后才出现在 `GET /api/posts` |
| 评论 | `pending` | 管理员 `approve` 后才出现在帖子下，且**此时**才计入 `comment_count` |

本轮修复的关键点：评论原先的实现是「命中规则才转人工、否则直接公开」，属于发布后审核；
现在规则命中（`flag` 字段）只是给审核员多一个提示，**不改变「必须先审」**。
计数也必须跟着审核动作走：通过 `+1`，把**已通过**的评论驳回 `-1`（`MAX(0, …)` 兜底），
否则 `comment_count` 会单向上漂，墙上显示的评论数就不可信了。

合规预筛（`server/src/moderation.js`）的定位是**确定性的规则筛查 + 人工复核触发器**，
命中任何规则一律进入人工复核队列，**不做自动删除**：

- **匹配前先归一化**：Unicode NFKC（全角折半角）+ 去掉零宽字符（`\u200b-\u200f`、`\ufeff` 等）；
- **结构性规则再匹配一次「紧凑形态」**：手机号 / 学号 / 社交账号 / 身份证类规则会把空白与分隔符
  （`1 3 8-0013 8000`）删掉后再匹配一次；邮箱与中文关键词不参与（删 `.` 会把邮箱拆坏）；
- **词表按 mtime 热重载**：改 `data/banned.txt` 后无需重启，默认 30 秒内生效
  （`BANNED_RELOAD_MS`，设 `0` 关闭）；
- 词表从 `BANNED_FILE`（默认 `server/data/banned.txt`）按行加载，支持 `#` 注释；
  仓库里只有 `server/data/banned.txt.example` 占位。

---

## 8. 低配 VPS 优化清单（带数字）

| 问题 | 原来 | 现在 |
| --- | --- | --- |
| **响应压缩** | 每个请求重新 gzip 一遍（200KB 的 JS 在单核上约 10–20ms，见 `server.js` 注释） | **br 优先 + gzip 兜底**，质量档自适应：**静态产物**（进压缩缓存，只压一次）< 64KB 用 `q11`、更大的用 `q9`；**动态 JSON** 用 `q5`（耗时与 gzip 同量级）；客户端不支持 br 时退回 `gzip-6`。代码注释里有实测：br **默认档 4 反而比 gzip-6 大 1%–7%**，所以必须抬档（app js 55KB：gzip-6 19776 / br-q5 17691 / br-q11 16303 字节）。缓存上限 64 条 / **8MB**（`COMPRESS_CACHE_MAX` / `COMPRESS_CACHE_BYTES_MAX`），响应体 ≥1KB 才压 |
| **静态缓存** | 带指纹资源 `max-age=86400` | 带内容哈希的产物 → `Cache-Control: public, max-age=31536000, immutable`；HTML → `no-cache` + `ETag`（改版即生效）；无指纹资源 → `86400` |
| **前端产物体积** | 框架与应用在同一个 chunk | 目标从 `es2019` 提到 **`es2020`**（`?.` / `??` 不再降级）、关闭 modulePreload polyfill、React 拆成独立 `vendor` chunk：当前 `web/dist` 实测 **应用 chunk ≈54 KiB、vendor ≈138 KiB、CSS ≈24 KiB**（gzip 后约 19 / 44 / 5 KiB）。**关键在于更新粒度：发版时老用户只需重新下载应用 chunk，vendor 走一年 immutable 缓存** |
| **连接层** | Node 默认 keep-alive 5s | `keepAliveTimeout=65s`（高于反代 60s，避免偶发 502）、`headersTimeout=66s`、`requestTimeout=30s`（挡慢速攻击） |
| **首屏并发** | 每个请求各查一次库 | `FEED_CACHE_MS=3000` 短时缓存把并发首屏合并成一次查询 + `ETag` 条件请求回 `304`；任何写操作立即失效缓存 |
| **翻页** | `OFFSET` 深翻页越翻越慢 | **keyset 分页**：行值元组比较 `(created_at, id) < (?, ?)`，一次索引区间扫描（`sort=hot` 同理由 `(like_count, id)` 承担） |
| **点赞写入** | 每次点赞一次 `UPDATE` | 内存队列 + `LIKE_FLUSH_MS=1500` 批量事务回写，合并 fsync |
| **数据库索引** | 8 个 | **9 个**（新增 `idx_feedback_status`），`server/scripts/db-check.js` 把数量写死断言，防止随手加冗余索引 |
| **启动耗时** | 每次启动全表重算 `like_count` | 只在崩溃恢复或距上次校准超过 `DB_RECOUNT_DAYS=7` 天时校准；干净退出写标记 |
| **WAL 膨胀** | 只在退出时 checkpoint | 启动 + 每 `DB_CHECKPOINT_MS=300000`（5 分钟）TRUNCATE checkpoint |
| **搜索引擎收录** | 无限制 | 内测版所有页面 `noindex, nofollow`（`index.html` 的 `<meta name="robots">`） |

数据库侧的完整取舍（覆盖索引、`auto_analyze=0`、页缓存按内存定档 16/32/64MB、
保留期清理）写在 `server/schema.sql` 与 `server/README.md`。

---

## 9. 测试矩阵

全部测试**零测试框架依赖**（Node 内置能力 + 无头 Edge / CDP），命令以 `package.json` 为准。

| 命令 | 跑什么 | 覆盖 |
| --- | --- | --- |
| `npm run tokens` | `python scripts/check-tokens.py` | `tokens.css` 与原型 `school-confession-wall.html` 的**第一个 `:root` 块**逐字一致（当前 53 个契约令牌） |
| `npm run smoke` | `scripts/smoke.mjs`：构建 + `vite preview` + 无头 Edge（`/api` 指向不存在的后端），**46 项** | 本地回落数据源、**本地模式不出现门禁弹层**、**内测标识与首屏公告**、设计令牌生效、排序 / 分类筛选 / 搜索、点赞与本地记忆、发布校验与「先审后发」提示、举报弹层、Esc 关闭、移动端单列与 ≥44px 触摸目标、无横向滚动、`reduced-motion` |
| `npm run smoke:api` | `scripts/api-smoke.mjs`：按后端契约写的假后端 + `vite preview` 代理，**15 项** | 探测 `/api/health` 后走 API、信息流来自后端、点赞用服务端权威计数、发布返回 `pending` 且不进墙、举报与**内测反馈**的请求体形状、门禁未启用时不弹层 |
| `npm run e2e` | `scripts/prod-e2e.mjs`：真后端（`NODE_ENV=production`）+ 真构建产物 + 无头浏览器，**47 项** | 生产验收全链路：启动守卫（未配邀请码拒绝启动）、**真实 UI 里输入邀请码 + 答本地挑战**、全新无痕上下文写请求仍 403、发布进审核队列、后台界面点「通过」后公开、评论先审后发、静态长缓存与 CSP |
| `npm --prefix server test` | `api-test.js && gate-test.js && db-check.js` | 见下三行 |
| ├ `cd server && npm run test:api` | 真起服务 + 临时库 + 临时端口 | keyset 分页（不重不漏、旧游标兼容、**缺省 `limit` 回归**）、ETag 304、门禁关闭/开启两档（无凭据 403 `gate_required`、邀请码错误、答对换会话、挑战一次性、伪造 cookie、登出后重新被拦）、先审后发、反馈长度校验、CSP 收紧、生产启动守卫 |
| ├ `cd server && npm run test:gate` | 按环境变量**分档**启动真实服务进程 | 门禁关闭档、开启档（配置字段、题数、题面不泄答案、邀请码校验、会话复用）、会话档（挑战绑 IP、过期、登出）、答错上限档、先审后发链路、反馈链路与后台队列、生产守卫档（无邀请码拒启 / `GATE_ALLOW_DISABLED=1` 可起）、`/api/gate/verify` 限流档 |
| └ `cd server && npm run test:db` | `db-check.js`（临时库） | 表与 **9 个索引**清单、关键查询 `EXPLAIN QUERY PLAN`（**`ANALYZE` 前后各断言一遍**）、点赞/评论计数一致性（含「驳回已通过评论 −1」）、举报去重索引、保留期清理（含反馈：已处理可删、未处理不可删）、干净退出标记 |
| `cd server && npm run db:check` | `db-check.js --real` | 对真实 `server/data/wall.db` 做只读体检（体积、页数、可回收空间、各表行数） |
| `cd server && npm run db:recount` | `db-check.js --recount` | 手动全量校准点赞计数（怀疑漂移时用） |
| `npm run verify` | 串跑：`tokens → build → smoke → smoke:api → server test → e2e` | 一键跑完以上全部 |

> 断言逐项打印 `✓ / ✗` 并由脚本自行汇总。上表项数取自 `npm run verify` 的一次完整跑通记录
> （46 / 15 / 47 与后端 46 + 56 + 50）；后续改代码后请以命令实际输出为准。
> 测试脚本默认使用**临时数据库与临时端口**，不会碰 `server/data/wall.db`。

---

## 10. 上线前必做

1. 按 **`DEPLOY.md`** 逐条配置：`GATE_INVITE_CODES`（≥8 位随机串）、`ADMIN_TOKEN`、
   `IP_HASH_SECRET`、`WEB_ROOT` 指向 `web/dist`、Caddy + systemd。
2. **限制 `/houtai/` 的访问来源**（推荐 SSH 隧道，不暴露公网）；老地址 `/admin` 只是钓鱼页，别把它当成防护。
3. `server/data/banned.txt` 换成经审阅的词库（从 `banned.txt.example` 复制）。
4. 页脚的「举报邮箱」还是占位符 `report@example.edu`（硬编码在 `web/src/components/Footer.jsx`），
   换成真实可用的邮箱；发布公约（`web/src/components/LegalSheet.jsx`）通读一遍，按本站实际情况补充 ——
   它现在只说本站真正做的事（不能发什么、平台留了什么记录、被举报了会怎样），
   法律条款清单与律师审阅意见不写进这份用户可见的文案。
   若另出隐私政策，需覆盖哈希后的 IP / UA 与保留期、「匿名不等于无资料」、查阅/更正渠道。
5. 考虑开启 `RETENTION_DAYS=90`（合规上通常需要明确的保留期限）。
6. 配好备份：`sqlite3 wall.db ".backup"`，或先 checkpoint 再打包 `server/data/`。
7. 邀请码的发放要有名单意识：内测站点的边界就是这枚口令，**别把它贴进公开群**。

### 关于「实名 / 短信」与「Turnstile」

内测版**不收集手机号、没有账号体系**。这两块代码已从仓库删除，需要恢复时从 git 历史取回：

```bash
git log --oneline -- server/src/identity.js   # bd5d85e feat: 后台实名（手机号验证）+ 先审后发 + 审核后台
git log --oneline -- server/src/sms.js        # 同一次提交
git show bd5d85e:server/src/identity.js > server/src/identity.js

git log --oneline -- server/src/challenge.js  # ebb0c36 feat: … + Turnstile 人机验证
git show ebb0c36:server/src/challenge.js > server/src/challenge.js
```

> **取回文件只是第一步。** 这两块能力当时并非独立模块：路由注册（`server/src/server.js`）、
> 数据库表与列（`server/schema.sql`）、前端上下文（`ChallengeContext` / `IdentityContext`）
> 与相关环境变量都已经一起删除，恢复时需要连同这些改动一起从对应提交取回（
> `git show bd5d85e --stat` / `git show ebb0c36 --stat` 可以看到完整文件清单）。

从旧库升级时，`server/src/db.js` 会做**尽力而为的幂等迁移**：删掉实名时代的索引与
`identities` / `identity_codes` 两张表，并尝试 `DROP COLUMN` 三处 `identity_id`；
**删不掉就保留为空列、代码不再读写**，绝不让一次清理失败导致服务起不来。

> 本文件、`DEPLOY.md`、`DESIGN.md` 与前端发布公约均为工程说明，**不构成法律意见**。
