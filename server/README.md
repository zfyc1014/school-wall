# 校园表白墙 · 后端（内测版 `0.9.0-beta.1`）

面向**最低配置 VPS**（1 vCPU / 1GB RAM 级别）与**香港部署**场景的后端服务：
Node 内置 `http` + SQLite(WAL)，**自托管内测门禁**（邀请码 + 一次性本地挑战 + HMAC 会话），
**不需要任何出网请求**。

前端有两个：React 版（`web/` 的 Vite 工程，构建到 `web/dist/`）与保留未改动的单文件原型
`school-confession-wall.html`。两者共用本服务的 `/api`，见第 5 节。

> **内测阶段不收集手机号、没有账号体系。** 实名与短信相关代码（`identity.js` / `sms.js`）
> 已从仓库删除，需要时从 git 历史取回：`git log --oneline -- server/src/identity.js`。
>
> 本文件是工程与部署说明，**不构成法律意见**。前端给用户看的只有一份**发布公约**
> （`web/src/components/LegalSheet.jsx`），内容是本站实际怎么做（不能发什么、留了什么记录、
> 被举报会怎样），不是法律模板；合规口径见第 9 节。

---

## 1. 技术选型与理由

| 决策 | 选择 | 为什么适合低配 VPS |
| --- | --- | --- |
| HTTP 框架 | Node 内置 `http` | 无框架开销，常驻内存小 |
| 数据库 | SQLite（WAL 模式） | 单文件、无独立进程，省下一整份数据库内存 |
| 分页 | keyset（游标）分页 | 行值元组比较走索引区间扫描，深翻页不扫全表 |
| 点赞写入 | 内存队列 + 定时批量回写 | 把多次 fsync 合并成一次事务 |
| 内测门禁 | 自托管（`src/gate.js`） | 不出网、无第三方数据处理、没有「校验服务不可达」这种失败模式 |
| 响应压缩 | br 优先（静态产物 q11/q9、动态 JSON q5）+ gzip-6 兜底 + 压缩结果缓存 | 静态产物只压一次；单核上省掉每次 10–20ms |
| TLS | Caddy / Nginx 终止 | 低配机器不承担 TLS 握手 CPU |
| 缓存 | 3 秒信息流缓存 + ETag + CDN | 并发首屏合并为一次查询，重复请求回 304 |
| 限流 | 进程内固定窗口 | 免去 Redis 的额外内存与运维 |

数据流：`浏览器 → Caddy(TLS/静态) → Node(动态 API) → SQLite(WAL)`。
写请求在进入业务逻辑前先过**内测门禁**（同步、无出网）→ 再过限流 → 落库为 `pending`。

---

## 2. 快速开始

```bash
cd server
npm install
cp .env.example .env                 # 按需修改；.env.example 是变量的权威清单
node src/server.js                   # 监听 127.0.0.1:8080
```

`server/.env` 由服务端**自动读取**（`src/env.js`，零依赖）：已存在的环境变量优先，
所以临时覆盖直接写在命令前面即可（`PORT=9000 node src/server.js`）。
Node 20+ 也可以写成 `node --env-file=.env src/server.js`，语义一致。
面板/容器部署没有 shell，只能靠这个文件配环境（见 `DEPLOY.md` §5.5）。

也可用 npm 脚本：

```bash
npm start        # node src/server.js
npm run dev      # node --watch src/server.js（改完自动重启）
```

启动后访问 `http://127.0.0.1:8080/`：静态根默认优先取 `web/dist`（存在 `index.html` 时），
否则回退到仓库根目录。想固定对外入口，显式配置 `WEB_ROOT` + `INDEX_FILE`（第 5 节）。

生产环境建议直接写入 `/etc/confession-wall.env` 并由 systemd 加载（见 `deploy/`）。

> **开发环境默认不需要邀请码**：`NODE_ENV` 不是 `production` 且未配置 `GATE_INVITE_CODES` 时门禁关闭，
> 写接口直接放行（启动日志会写明）。要本地验证门禁：
> `GATE_ENFORCE=1 GATE_INVITE_CODES=dev-beta-2026 node --env-file=.env src/server.js`

---

## 3. 环境变量

完整清单与默认值以 **`.env.example`** 为准；下表按用途分组，括号内是默认值。

### 服务

| 变量 | 说明 |
| --- | --- |
| `HOST` (`127.0.0.1`) / `PORT` (`8080`) | 只监听回环，由反代对外 |
| `NODE_ENV` | `production` 时启用两道启动守卫（见 3.5） |
| `WEB_ROOT` | 静态根；留空自动探测（`web/dist` 优先，否则仓库根） |
| `INDEX_FILE` (`index.html`) | 请求路径为 `/` 时返回的文件 |
| `TRUST_PROXY` | 反代后置 `1`，读取 `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Proto` |
| `FORCE_HTTPS` | `1` 时输出 HSTS |
| `MAX_BODY` (`32768`) / `PAGE_MAX` (`30`) | 请求体上限（字节）/ 单页最大条数 |

### 内测门禁（`src/gate.js`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATE_ENFORCE` | 生产且已配邀请码时开启 | `1` 强制 / `0` 关闭（会打警告）；显式配置优先 |
| `GATE_INVITE_CODES` | 空 | 邀请码，逗号或空格分隔；**每个 ≥8 位**，过短的被忽略并打警告 |
| `GATE_TTL` | `43200` | 会话有效期（秒），范围 60–2592000 |
| `GATE_CHALLENGE_TTL` | `600` | 挑战有效期（秒），范围 30–3600 |
| `GATE_CHALLENGE_ITEMS` | `2` | 每次挑战题目数，范围 1–4 |
| `GATE_MAX_ATTEMPTS` | `5` | 单份挑战允许答错次数，范围 1–20 |
| `GATE_COOKIE` | `od_gate` | 会话 cookie 名 |
| `GATE_COOKIE_SECURE` | 跟随协议（auto） | 留空 = **auto**：HTTPS 请求带 `Secure`、HTTP 请求不带；`1` = 强制带、`0` = 强制不带（生产下启动会打警告）。纯 HTTP 部署不需要再手工设 `0`；HTTP 下 cookie 仍是明文传输 |
| `GATE_SECRET` | 复用 `IP_HASH_SECRET` | 会话签名密钥；更换会让所有在线会话失效 |
| `GATE_ALLOW_DISABLED` | — | 逃生开关：生产未配邀请码时显式放行启动 |

### 内测标识与反馈（`src/beta.js`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BETA_VERSION` | `0.9.0-beta.1` | 下发前端的版本号（顶栏、页脚、`/api/health`） |
| `BETA_NAME` | `内测版` | 版本标识文案 |
| `BETA_NOTICE` | 内置文案 | 首屏公告；改文案不必重新构建前端 |
| `BETA_FEEDBACK` | 开 | `0` = 关闭反馈入口 |
| `FEEDBACK_EMAIL` | 空 | 选填，展示给用户并作为备用渠道 |
| `FEEDBACK_MAX` | `800` | 反馈正文上限，范围 20–4000 |
| `FEEDBACK_KEEP` | `2000` | 反馈保留条数（最小 100）；只清理已处理的旧反馈 |

### 安全与限流

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | 管理接口令牌，**≥24 字符**（生产缺失即退出） |
| `IP_HASH_SECRET` | — | IP 哈希密钥，**≥16 字符**（生产缺失即退出）；不落盘原始 IP |
| `ADMIN_RATE_LIMIT` | `10` | **令牌错误**的鉴权尝试上限（15 分钟窗口，按 IP 哈希），防爆破 |
| `ADMIN_API_RATE_LIMIT` | `600` | 已鉴权管理请求上限（5 分钟窗口），只防脚本刷库；太小会让后台控制台自己把自己挡住 |

### 数据与性能

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_PATH` | `server/data/wall.db` | SQLite 路径（WAL，同目录生成 `-wal` / `-shm`） |
| `DB_CACHE_MB` | 按内存自动（≤1GB→16，≤2GB→32，否则 64） | 页缓存（MB），同时决定 `mmap_size` |
| `DB_CHECKPOINT_MS` | `300000` | WAL 截断间隔（5 分钟） |
| `DB_CLEANUP_MS` | `21600000` | 保留期清理 + `PRAGMA optimize` 间隔（6 小时） |
| `RETENTION_DAYS` | `0` | `0` = 不按时间清理；`>0` 清理超期被拒内容、已结案工单、审计日志、已处理反馈 |
| `DB_RECOUNT_ON_BOOT` | `0` | `1` = 启动强制全量校准点赞计数 |
| `DB_RECOUNT_DAYS` | `7` | 距上次校准超过该天数则校准一次；`0` = 永不 |
| `LIKE_FLUSH_MS` | `1500` | 点赞计数批量回写间隔 |
| `FEED_CACHE_MS` | `3000` | 信息流短时缓存；`0` = 关闭 |
| `BANNED_FILE` | `./data/banned.txt` | 合规词表路径（每行一个，`#` 注释）；缺省不加载 |
| `BANNED_RELOAD_MS` | `30000` | 词表按 mtime 热重载的检查间隔；`0` = 关闭热重载 |
| `DEBUG_EXIT` | — | `1` 时在进程退出前把 `process.exit` 调用栈写到 stderr（排障用） |

### 3.5 生产启动守卫

`NODE_ENV=production` 时，下面任一条件不满足都会**打印原因并以退出码 1 退出**：

1. 已配置 `GATE_INVITE_CODES`（或显式 `GATE_ALLOW_DISABLED=1`）；
2. `ADMIN_TOKEN` ≥24 字符；
3. `IP_HASH_SECRET` ≥16 字符。

报错原文：

```
[fatal] 未配置 GATE_INVITE_CODES，内测门禁关闭 ——
  生产环境默认拒绝以此状态启动（任何人都能直接调写接口）。
  修复：设置 GATE_INVITE_CODES=<至少 8 位的邀请码，逗号分隔可配多个>；
        或显式设置 GATE_ALLOW_DISABLED=1 明确承担风险。
```

---

## 4. API

所有响应为 JSON。写接口按 IP 哈希限流，超限返回 `429` 与 `retryAfter`（秒）。
未通过内测门禁的写请求一律 `403 {"error":"gate_required"}`（服务端强制，与前端按钮无关）。

### 公开 / 读

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `{ok, now, version, tag}`；版本与内测标识由 `beta.js` 下发 |
| `GET` | `/api/posts?cat=&sort=new\|hot&q=&cursor=&limit=` | 只返回 `approved`；`limit` 默认 20、上限 `PAGE_MAX`；返回 `{items, nextCursor, sort}`，带 `ETag`（条件请求回 `304`）与 `X-Cache: hit\|miss` |
| `GET` | `/api/posts/:id/comments` | 只返回 `approved` 评论，最多 200 条 |

游标格式：`sort=new` 为 `created_at.id`，`sort=hot` 为 `like_count.id`（行值元组比较翻页；
同时兼容旧版纯 `id` 游标）。`nextCursor` 为 `null` 表示到底。

### 内测门禁（`src/gate.js`）

| 方法 | 路径 | 限流 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/gate/config` | — | `{enabled, required, inviteRequired, sessionTtl, challengeTtl, challengeItems, verified, beta, error}`，公开、不含机密 |
| `POST` | `/api/gate/challenge` | 30 / 10 分钟 | 取一份一次性挑战 `{enabled, id, items:[{q}], expiresAt, ttlSeconds}`；**答案只存在服务端内存**；门禁关闭时返回 `{enabled:false}` |
| `POST` | `/api/gate/verify` | 20 / 10 分钟 | `{code, challengeId, answers[]}` → 成功 `200 {verified:true, expiresIn}` + `Set-Cookie: od_gate=…`（HMAC 签名、绑定 IP 哈希、HttpOnly、SameSite=Lax；`Secure` 跟随请求协议，HTTPS 带、HTTP 不带） |
| `POST` | `/api/gate/logout` | — | 清 cookie，返回 `{verified:false}` |

失败码：`invalid_code`（403，邀请码错误；刻意不区分「空」与「错」以免辅助枚举）、
`challenge_expired`（409）、`challenge_failed`（403，带 `remaining`）、`rate_limited`（429）。
挑战一次性：答对即作废；答错超过 `GATE_MAX_ATTEMPTS` 整份作废。

### 写（需过门禁）

| 方法 | 路径 | 限流 | 校验与行为 |
| --- | --- | --- | --- |
| `POST` | `/api/posts` | 3 / 10 分钟 | `{cat, body}`；`cat` ∈ 表白/树洞/寻人/失物/致谢；`body` 6–500 字；**一律写入 `pending`**，返回 `201 {id, status:"pending"}` |
| `POST` | `/api/posts/:id/like` | 120 / 5 分钟 | 幂等切换（同一 IP 再点即取消），返回 `{liked, likes}`；计数异步批量回写 |
| `POST` | `/api/posts/:id/comments` | 20 / 5 分钟 | `{body}` 1–120 字；**一律 `pending`**；`comment_count` 只在审核通过时 +1 |
| `POST` | `/api/reports` | 10 / 小时 | `{postId, reason?}`；同一 IP 对同一帖只记一条 open 工单（重复返回 `{ok:true, duplicated:true}`） |
| `POST` | `/api/feedback` | 5 / 小时 | `{cat, body, contact?}`；`cat` ∈ bug/idea/other；`body` 4–`FEEDBACK_MAX`（默认 800）字；`contact` ≤120 字；返回 `201 {ok, id}` |

### 管理接口（需鉴权）

鉴权：`Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token: <ADMIN_TOKEN>`
（常量时间比对）。限流分两个桶：**令牌错误**的尝试按 `ADMIN_RATE_LIMIT` / 15 分钟掐；
**已鉴权**的请求按 `ADMIN_API_RATE_LIMIT` / 5 分钟掐（默认 600，宽松，只防脚本刷库）。
两者混在一个桶里会让后台控制台自己把自己挡住 —— 它一进页面就要打 6 个接口。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/stats` | 待审计数、`pendingTotal`、`oldestPendingAt`、`generatedAt`、`openFeedback`、`gateRequired`、`gateInviteRequired`、`betaVersion`、`db.{fileBytes,reclaimableBytes,walBytes,cacheMb,counts}` |
| `GET` | `/api/admin/queue?type=posts\|comments&limit=&cursor=&q=` | 待审队列（`limit` 默认 50、上限 100；`q` 按正文搜索，评论还会搜所属帖子正文）；返回 `{type, items, total, nextCursor}`；游标 `created_at.id`，按时间**正序**处理 |
| `GET` | `/api/admin/posts/:id` | 单帖详情：正文 + 全部评论（≤500）+ 相关工单（≤50） |
| `POST` | `/api/admin/posts/:id/approve\|reject\|remove` | 审核/下架帖子；`remove` 会连带把该帖 open 工单标记 `actioned` |
| `POST` | `/api/admin/comments/:id/approve\|reject` | 审核评论；通过 +1、把已通过的评论驳回 −1（`MAX(0, …)` 兜底） |
| `POST` | `/api/admin/bulk` | `{type:'posts'\|'comments', ids:[…≤100], action}`；一次事务处理多条，返回 `{updated:[], skipped:[]}` |
| `GET` | `/api/admin/audit?action=&limit=` | 审核留痕（`limit` 默认 50、上限 200）；**不返回 `ip_hash`** |
| `GET` | `/api/admin/reports?status=open\|actioned\|dismissed\|all&limit=` | 工单队列（默认 `open`、`limit` 上限 200），LEFT JOIN 带出被举报的帖子/评论正文与状态 |
| `POST` | `/api/admin/reports/:id/resolve` | `{"action":"takedown"\|"dismiss"}`；`takedown` 下架内容并把该帖全部 open 工单结案 |
| `GET` | `/api/admin/feedback?status=open\|done\|dismissed\|all&limit=` | 内测反馈队列（默认 `open`，`limit` 上限 200） |
| `POST` | `/api/admin/feedback/:id/resolve` | `{"action":"done"\|"dismiss"}`（无请求体时按 `dismiss` 处理） |
| `POST` | `/api/admin/shutdown` | 受控优雅停机（写入干净退出标记、`PRAGMA optimize`、截断 WAL），不依赖信号 |

```bash
TOKEN=$(openssl rand -hex 32)   # 与 .env 中一致
curl -s 'http://127.0.0.1:8080/api/admin/queue?type=posts' -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8080/api/admin/posts/12/approve -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8080/api/admin/bulk -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"type":"comments","ids":[34,35],"action":"approve"}'
```

### 审核后台（不经过 API 也可以）

浏览器打开 **`/houtai/`**（`GET /houtai`、`/houtai/`、`/houtai/index.html` 都指向由本服务
直接提供的单文件页面 `public/admin.html`，始终从 `server/public/` 读取，**不受 `WEB_ROOT` 影响**）。
导航为五个工作区：概览 / 待审队列 / 举报工单 / 审核日志 / 内测反馈；支持关键词搜索、
批量通过/驳回/下架、帖子详情、以及**无后端演示模式**（连不上 `/api` 时自动进入，操作只在本页生效）。

**老地址 `/admin` 是钓鱼页**：`GET /admin`、`/admin/`、`/admin.html` 统一返回一张静态页面
（HTTP 200，正文只有一句「你以为我会傻到这种程度？」），不含控制台结构、也不含 `ADMIN_TOKEN`
（实现见 `src/server.js` 的 `DECOY_HTML`）。这是**降噪**，把扫描器、旧书签和顺手猜路径的流量
挡在后台入口之外，**不是安全措施** —— `/api/admin/*` 接口路径没有变。

> 页面本身不设登录墙（它用令牌调管理接口，令牌存在浏览器 localStorage），因此
> **必须在反代层限制来源**，或干脆只在 SSH 隧道内访问。详见根目录 `DEPLOY.md` 第 6 节。

### 一个值得留在这里的路由顺序教训

管理端曾经把列表路由 `/api/admin/identities` 注册在参数路由 `/api/admin/identity/:id` 之后，
而 `:id` 编译出的正则 `([^/]+)` 会把字面量 `identities` 也吃掉 —— 列表请求被参数路由接管，
只返回一条记录。**新增参数路由时请务必先注册字面量路由**（见 `src/server.js` 中
`/api/admin/feedback` 上方的注释）。

---

## 5. 把前端接到后端

仓库里有两个前端，**共用同一套 `/api`**，静态服务只认 `WEB_ROOT` + `INDEX_FILE`：

| 前端 | 入口 | 说明 |
| --- | --- | --- |
| React 版（推荐） | `web/dist/index.html` | `web/` 的 Vite 产物，内置数据源探测与回落 |
| 单文件原型 | `school-confession-wall.html` | 保留未改动的视觉基线（历史原型），`localStorage` 演示数据；其中的法律文案不代表线上站点 |

```bash
npm run build                                  # 仓库根执行，产物落在 web/dist/
# server/.env
WEB_ROOT=/srv/confession-wall/web/dist
INDEX_FILE=index.html
```

想继续对外提供单文件原型，把 `INDEX_FILE` 改回 `school-confession-wall.html` 即可，不需要改代码。
Caddy 侧把 `web/dist/assets` 当纯静态目录长缓存分发（见 `deploy/Caddyfile`）。

开发期不需要这样部署：仓库根的 `npm run dev` 已把 `/api` 代理到 `127.0.0.1:8080`，
浏览器里直接 `fetch('/api/...')` 即命中本服务，**无需 CORS**。

### 5.1 React 版如何选择数据源

`web/src/data/adapters.js` 启动时探测 `GET /api/health`：

- 成功 → 使用 http 适配器，页脚显示「已连接后端 API · 内容先审后发」
- 失败 → 回落到 localStorage 演示适配器，页脚显示「后端连接失败 · 已回落到本地演示数据」

用 `VITE_DATA_MODE=auto|api|local` 固定行为（`api` 表示不做静默回落）。
写请求遇到 `403 gate_required` 时，数据层会调用门禁的 `ensureVerified()` 弹出门禁弹层，
用户通过后**自动重试原请求一次**（只重试一次，避免验证失败造成请求风暴）。

`window.__WALL_DEBUG__` 会暴露当前 `mode / source / gate / beta / sheets` 状态，
供 `scripts/smoke.mjs`、`scripts/prod-e2e.mjs` 在无头浏览器里断言（不暴露任何答案或令牌）。

### 5.2 单文件原型的接法（历史方案）

原型的 `renderWall()` 用 `state.posts` 作为数据源；接入真实后端时保留渲染逻辑、只替换数据来源。
**注意：内测版的写接口需要门禁会话 cookie**，因此原型要带 `credentials: 'same-origin'`，
并在收到 `403 gate_required` 时提示用户到 React 版（或自行实现）过门禁：

```js
// 最简 API 客户端（同源部署，无需 CORS）
const api = {
  async feed(cursor, sort = 'new') {
    const u = new URL('/api/posts', location.origin);
    u.searchParams.set('sort', sort);
    if (cursor) u.searchParams.set('cursor', cursor);
    return (await fetch(u)).json();
  },
  async publish(cat, body) {
    const r = await fetch('/api/posts', {
      method: 'POST',
      credentials: 'same-origin',          // 带上 od_gate 会话 cookie
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cat, body })
    });
    if (r.status === 403) throw new Error('请先完成内测验证（邀请码 + 本地题目）');
    if (r.status === 429) throw new Error('操作过于频繁，请稍后再试');
    return r.json();
  },
  async like(id) {
    return (await fetch(`/api/posts/${id}/like`, { method: 'POST', credentials: 'same-origin' })).json();
  },
  async comment(id, body) {
    return (await fetch(`/api/posts/${id}/comments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body })
    })).json();
  },
  async report(postId, reason) {
    return (await fetch('/api/reports', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId, reason })
    })).json();
  }
};
```

映射关系：`renderWall()` 的 `state.posts` ← `GET /api/posts`；提交弹层 ← `POST /api/posts`；
点赞按钮 ← `POST /api/posts/:id/like`；评论 ← `GET/POST /api/posts/:id/comments`；
举报 ← `POST /api/reports`。

因为前端与后端**同源**部署（同一域名），无需配置 CORS，也不引入第三方 JS。

---

## 6. 数据库 schema 与索引预算

结构在 `schema.sql`（幂等，由 `src/db.js` 启动时执行）。7 张表：

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `posts` | `status`（`pending` 默认 / `approved` / `rejected` / `removed`）、`like_count`、`comment_count`、`flag`、`ip_hash`、`ua_hash`、`created_at`、`reviewed_at` | 先审后发；`flag` 是规则命中的原因（逗号分隔），供人工复核 |
| `comments` | `post_id`（外键级联）、`status`（**默认 `pending`**）、`flag`、`ip_hash`、`created_at` | 与帖子同口径的先审后发。曾经这里写的是 `DEFAULT 'approved'`，与写入路径不一致，已修正 |
| `likes` | `PRIMARY KEY (post_id, ip_hash)`，`WITHOUT ROWID` | 主键天然去重，点赞是幂等切换 |
| `reports` | `post_id`、`comment_id`、`status`（`open` / `actioned` / `dismissed`）、`resolved_at` | 通知—移除工单 |
| `feedback` | `cat`（bug/idea/other）、`body`、`contact`（选填）、`status`（`open` / `done` / `dismissed`）、`ip_hash`、`ua_hash` | 内测反馈；不参与公开内容，因此不进信息流缓存 |
| `audit_log` | `action`、`target`、`note`、`ip_hash`、`created_at` | 审核留痕（接口不返回 `ip_hash`） |
| `stats` | `key` / `value` / `updated_at`（`WITHOUT ROWID`） | 元信息：干净退出标记、上次点赞校准时间 |

### 9 个索引，以及为什么正好是 9 个

索引不是越多越好：每个索引都会拖慢写入并占用内存，低配机器上宁可用更少的索引 + 更稳定的查询计划。
当前清单（`db-check.js` 把数量写死断言，防止随手加冗余索引）：

| # | 索引 | 服务的查询 |
| --- | --- | --- |
| 1 | `idx_posts_feed (status, created_at, id)` | 首屏/列表 keyset 分页（**覆盖索引**，正序遍历即审核队列的「最久待审」） |
| 2 | `idx_posts_hot (status, like_count, id)` | 热榜排序 |
| 3 | `idx_posts_cat (status, cat, created_at, id)` | 分类页 |
| 4 | `idx_comments_post (post_id, status, id)` | 帖子下取已通过评论 |
| 5 | `idx_comments_queue (status, created_at, id)` | 评论审核队列 |
| 6 | `idx_reports_status (status, id DESC)` | 工单列表（`open` 与任意 status 都用这一条） |
| 7 | `idx_reports_post (post_id, ip_hash)` | 同一 IP 重复举报去重 |
| 8 | `idx_audit_time (created_at DESC)` | 审核日志倒序 |
| 9 | `idx_feedback_status (status, id DESC)` | 内测反馈队列（**0.9 新增的唯一索引**） |

几条设计说明：

- **覆盖索引优先。** `(status, created_at, id)` 已包含列表要返回的列，SQLite 只读索引就能出结果
  （计划里显示 `COVERING INDEX`）。原因是实测过的坑：跑过 `ANALYZE`、有了统计信息后，优化器会认为
  「`status='approved'` 几乎命中整表 → 全表扫 + 排序更便宜」，于是放弃索引。让索引覆盖查询列之后，
  任何统计信息下都不会被放弃。正文 `body` 不进索引 —— 那会让索引体积翻倍。
- **关掉 `auto_analyze`。** 低配机器上「计划稳定」比「计划可能更聪明」更值钱；需要统计信息时用
  `PRAGMA optimize`（退出时与每 6 小时自动执行）或 `scripts/db-check.js` 手动触发。
- **审核链路没有新增索引**（除反馈外）。队列/详情/留痕/工单接口全部复用上表既有索引，
  `schema.sql` 顶部有逐条对照。
- **迁移是幂等的。** `schema.sql` 里的 `DROP INDEX IF EXISTS` 用来清掉旧版本建过、已被更合适索引
  取代的索引（同名不同列时 `CREATE INDEX IF NOT EXISTS` 不会自动改）。

---

## 7. 测试脚本

全部零依赖（不需要 Jest/Playwright），默认使用**临时数据库与临时端口**，不会碰 `data/wall.db`。

```bash
npm test              # api-test.js && gate-test.js && route-sweep.js && db-check.js
npm run test:api      # 只跑接口（真实起服务）
npm run test:gate     # 只跑门禁（按环境变量分档启动真实服务进程）
npm run test:sweep    # 只跑路由巡检（注册表里每个路由都打一遍，只看 5xx）
npm run test:db       # 只跑数据库自检
npm run db:check      # 针对真实 data/wall.db 的只读体检（--real）
npm run db:recount    # 手动全量校准点赞计数（--recount）
```

| 脚本 | 测什么 |
| --- | --- |
| `scripts/api-test.js` | 对着真实 `src/server.js` 发请求（不是 mock）：keyset 分页不重不漏、旧版纯 id 游标兼容、**缺省 `limit` 回归**（`toInt` 少写「null/空串走 fallback」会把首屏吞成 1 条）、`ETag` 304、门禁关闭档（不下发任何第三方挑战密钥的反向断言）、开启档（无凭据 403 `gate_required`、邀请码错误、答对换会话、挑战一次性、答错超限、伪造 cookie、登出后重新被拦）、先审后发、反馈长度校验、CSP 收紧到 `'self'`、**生产环境未配置邀请码时拒绝启动** |
| `scripts/gate-test.js` | 门禁的行为完全由环境变量决定，因此**按档启动服务进程**：① 关闭档（不出题、写接口放行）；② 开启档（配置字段、题数与题面不泄答案、邀请码空/错/多码、答对换会话、会话复用）；③ 会话档（挑战绑定 IP、会话有效期、登出清 cookie）；④ 答错上限档（剩余次数递减 → 超限作废 → 答案正确也不再受理）；⑤ 先审后发链路（含审核队列与统计）；⑥ 反馈链路（需过门禁、后台可读、resolve 后出队）；⑦ 生产守卫档（无邀请码拒启 / `GATE_ALLOW_DISABLED=1` 可起）；⑧ 限流档（`/api/gate/verify` 20 次/10 分钟后 429） |
| `scripts/route-sweep.js` | **路由巡检**：正则读出 `server.js` 里注册过的每个路由（含循环注册的 `/api/admin/…/:action`），起一个生产模式 + 门禁开启的真实服务，过门禁、造好帖子/评论/工单/反馈，然后**逐条打一遍**，断言没有任何 5xx。4xx 一律算正常拒绝（鉴权、限流、参数不合法、内容不存在）。存在的理由：测试按功能链路组织，**不属于任何链路的处理器就是盲区** —— 点赞接口曾把 SQL 保留字 `ON` 当列别名（`SELECT 1 AS on`），真实后端上一直是 500，而 smoke（本地模式）、api-smoke（自带 mock）、prod-e2e（没点过赞）、db-check（直接写表）四个套件全绿却没有一个碰到它。新增路由即使不写针对性断言，也不会再悄无声息地 500 |
| `scripts/db-check.js` | 结构（表与 **9 个索引**清单）、关键查询 `EXPLAIN QUERY PLAN`（**`ANALYZE` 前后各断言一遍**，防止统计信息一更新就退化成全表扫描）、写入与计数一致性（点赞批量回写、评论先审后发 +1/−1、下架级联）、举报去重索引、保留期清理（含反馈：已处理可删、**未处理不能被时间清掉**；不开启保留期时只做结构性清理）、启动路径与干净退出标记 |

`db-check.js` 的用法（脚本自己解析参数）：

```bash
node scripts/db-check.js                      # 临时库跑全部检查
node scripts/db-check.js --db ./data/wall.db  # 针对指定库
node scripts/db-check.js --real               # 针对真实 data/wall.db（npm run db:check）
node scripts/db-check.js --recount            # 额外做一次全量点赞校准
```

---

## 8. 维护与排障

### 日常

- **启动**：清理过期临时对象 → 必要时校准点赞计数 → 一次 TRUNCATE checkpoint → 孤儿行清理。
- **运行中**：每 5 分钟 WAL 截断；每 6 小时保留期清理 + `PRAGMA optimize`（两个定时器都 `unref`，
  不阻止进程退出）。
- **退出**：写干净退出标记（`stats.clean_shutdown`）→ `PRAGMA optimize` → TRUNCATE checkpoint。
  刻意**不调用 `process.exit()`**：带活跃 better-sqlite3 连接强退会偶发触发原生断言（Windows 上尤其明显）。

### 常见问题

| 现象 | 定位 | 处理 |
| --- | --- | --- |
| 生产起不来，日志含 `GATE_INVITE_CODES` | 启动守卫 | 配置邀请码，或显式 `GATE_ALLOW_DISABLED=1`（第 3.5 节） |
| 日志含 `ADMIN_TOKEN 未设置或过短` / `IP_HASH_SECRET 未设置或过短` | 启动守卫 | 补齐密钥（`openssl rand -hex 32`） |
| 所有人共享同一门禁会话 / 限流误伤 | `TRUST_PROXY` 未开 | 反代后必须 `TRUST_PROXY=1`，否则所有请求都被算成 `127.0.0.1` |
| 用户频繁遇到「验证已过期」 | `GATE_CHALLENGE_TTL` 太短或用户中途换网络（挑战绑 IP 哈希） | 调大 TTL；换网络时重新取题即可 |
| 首页只返回 1 条 | 历史 bug：`toInt` 把缺省 `limit` 吞成 0 | 已在 `toInt` 里显式挡住 `null` / 空串；`api-test.js` 有回归断言 |
| 列表查询变慢 | 查询计划退化 | `node scripts/db-check.js` 看 `EXPLAIN QUERY PLAN`；确认索引齐全（9 个） |
| `-wal` 文件持续变大 | checkpoint 未生效 | 检查是否有长事务 / 常驻只读连接；必要时手动 `PRAGMA wal_checkpoint(TRUNCATE)` |
| 磁盘只涨不降 | freelist 未回收 | 低峰期 `VACUUM`（需独占），见根目录 `DEPLOY.md` 第 7 节 |
| 点赞/评论数看起来不对 | 计数漂移 | 点赞：`npm run db:recount`；评论数由审核动作维护（通过 +1、驳回已通过 −1） |
| 词表改了没生效 | 热重载间隔 | 默认 30 秒内生效（`BANNED_RELOAD_MS`）；设 `0` 会关闭热重载 |
| 审核日志看不到 IP | 设计如此 | `GET /api/admin/audit` 刻意不返回 `ip_hash`（留痕只需「谁在何时做了什么」） |
| 跨设备会话失效 | cookie 绑定 IP 哈希 | 预期行为：换网络 / 换设备需要重新过门禁 |
| 验证通过后又立刻要求验证 | cookie 被浏览器丢弃 | 看启动日志的 cookie 模式：`cookie 强制 Secure` 说明 `GATE_COOKIE_SECURE=1`，纯 HTTP 站点下浏览器会丢 cookie → 改成留空（auto）或 `0`。若日志本来就是「跟随协议」，再查是不是换了域名/端口访问 |

### 低配 VPS 调优清单

- **加 swap**（防 Node 尖峰 OOM）：`fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`，写入 `/etc/fstab`。
- **静态走 CDN / 反代直发**：源站只处理动态请求；带哈希产物一年 immutable，HTML 每次校验 ETag。
- **压缩已内置**：br 优先 + gzip 兜底，静态产物只压一次（缓存上限 8MB）。Caddy 侧另有 `encode zstd gzip`。
- **信息流缓存 + ETag**：3 秒内相同查询合并成一次数据库读取，重复请求回 304。
- **数据库调优已内置**：页缓存按内存定档、WAL 定时截断、`PRAGMA optimize`、`auto_analyze=0`。
- **内存护栏**：systemd 单元已设 `MemoryMax=256M`，超限自动重启而不是拖垮整机。
- **不引入 Redis/MySQL**：单进程 + SQLite 足够支撑校园级流量；需要横向扩容时替换 `rate-limit.js`
  （接口不变）并迁移到 Postgres。**注意：门禁会话与挑战都在进程内存里，横向扩容需要改成共享存储。**
- **图片**：走对象存储前端直传 + 客户端压缩，源站不落盘原图；若必须自存，务必另设子域并禁用该子域的脚本执行。

---

## 9. 香港合规要点（工程侧）

> 以下为工程实践提示，**不是法律意见**；具体义务请咨询香港执业律师。

- **个人资料（隐私）条例 · 第 486 章（PDPO）**
  - 数据最小化：本服务**不存储原始 IP**，只存 `HMAC-SHA256(IP)` 前 24 位，用于去重与反滥用；
    **内测阶段不收集手机号**，也没有账号体系。
  - 匿名不等于无资料：仍属个人资料处理，需在隐私政策中说明收集目的（举报核查、安全审计）、
    保留期限与查阅/更正渠道。
  - 保留期限：建议 `audit_log`、已结案 `reports`、被拒内容与已处理反馈设定期限（如 90 天）自动清理
    （`RETENTION_DAYS`）；**未处理的反馈不会被清理**。
- **2021 年修订：起底刑事化**
  - 未经同意披露他人个人资料**并意图造成伤害**可能构成刑事罪行。前端发布公约与后端
    `moderation.js` 的联系方式/身份规则，正是为了把此类内容在公开前拦下转人工。
  - 预筛已做 Unicode NFKC 归一化、去零宽字符，并对结构性规则额外匹配「紧凑形态」；
    但这只是提高命中率，**真正的兜底是人工审核**。
- **《诽谤条例》第 21 章**：平台采取「通知—移除」，收到有效通知后尽快下架；
  `reports` 表即通知—移除工单。
- **《淫亵及不雅物品管制条例》第 390 章**：不雅内容需及时下架，词表应覆盖相关类别。
- **未成年人**：涉及未成年人的内容优先级更高，应人工复核；建议在公约中加入监护人同意条款。
- **数据出境**：哈希后的 IP、内容与反馈都留在本机 SQLite；若备份同步到境外服务商，
  需评估 PDPO 跨境转移要求。
- **处置留痕**：`audit_log` 记录管理员动作，便于在争议或执法查询时说明处置过程。

**上线前必做**：把页脚的举报邮箱占位符 `report@example.edu`（硬编码在 `web/src/components/Footer.jsx`）
换成真实邮箱；把发布公约（`web/src/components/LegalSheet.jsx`）通读一遍并按本站实际情况补齐；
`data/banned.txt` 换成经审阅的词库。法例清单与合规口径留在本文档第 9 节，不要写进用户可见的公约。

---

## 10. 安全清单

- [x] 默认只监听 `127.0.0.1`，由反代终止 TLS
- [x] 全站安全头（CSP、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、
      `Permissions-Policy`、`Cross-Origin-Opener-Policy`、HSTS）
- [x] **CSP 收紧到 `'self'`**：`default-src 'self'`、`script-src 'self' 'unsafe-inline'`、
      `frame-src 'none'`、`connect-src 'self'`、`frame-ancestors 'none'`；页面不加载任何第三方脚本
- [x] **写接口服务端强制内测门禁**（不依赖前端按钮）：邀请码只存 HMAC、常量时间比较；
      挑战一次性、答案只在服务端内存、绑定 IP 哈希；会话 cookie HMAC 签名 + `HttpOnly` + `SameSite=Lax`
- [x] 生产环境未配置邀请码时**拒绝启动**（退出码 1），而不是让写接口裸奔
- [x] 管理接口常量时间比对令牌（`timingSafeEqual`）；管理鉴权与门禁校验单独限流
- [x] 写接口按 IP 哈希限流；请求体上限 + JSON 解析失败返回 400
- [x] 静态服务路径穿越防护（`filePath.startsWith(WEB_ROOT + sep)`）；`/houtai/` 固定在 `server/public`，
      老路径 `/admin` 只返回不回显任何结构的钓鱼页（降噪，非安全措施）
- [x] SQL 全部参数化；搜索用 `LIKE ... ESCAPE` 转义 `% _ \`
- [x] 审核接口不返回 `ip_hash`；后台不把任何哈希写入 DOM
- [x] 优雅退出：回写点赞计数、`PRAGMA optimize`、`wal_checkpoint(TRUNCATE)`、写干净退出标记
- [x] 同一 IP 对同一帖的重复举报去重（防止刷爆工单队列）
- [x] 旧库升级时幂等清理实名时代的表与列（删不掉就保留空列，不影响启动）
- [ ] CSP 仍为内联样式放行 `'unsafe-inline'`；进一步加固可提取样式并改用 nonce
- [ ] 生产环境建议在反代层再加一层请求速率与 WAF 规则，并限制 `/houtai/` 来源

---

## 11. 目录结构

```
server/
├─ package.json
├─ .env.example                环境变量的权威清单（含默认值与范围）
├─ schema.sql                  数据库结构（幂等，含索引预算与迁移说明）
├─ public/admin.html           审核后台（单文件零构建，访问 /houtai/；老路径 /admin 只回钓鱼页）
├─ data/                       SQLite 数据与 banned.txt（勿提交；有 banned.txt.example 占位）
├─ deploy/
│  ├─ confession-wall.service  systemd 单元（含资源护栏）
│  └─ Caddyfile                反代 + 自动 HTTPS + 静态直发
├─ scripts/
│  ├─ api-test.js              接口测试（真起服务 + 临时库）
│  ├─ gate-test.js             内测门禁分档测试
│  ├─ route-sweep.js           路由巡检（注册表里每个路由都打一遍，只看 5xx）
│  └─ db-check.js              数据库自检（结构 / 查询计划 / 计数 / 清理 / 退出标记）
└─ src/
   ├─ server.js                HTTP 服务 / 路由 / 静态资源 / 压缩 / 缓存
   ├─ db.js                    SQLite 连接、调优、迁移与数据维护
   ├─ gate.js                  内测门禁（邀请码 + 本地挑战 + 会话 cookie）
   ├─ beta.js                  内测版元信息与反馈配置
   ├─ moderation.js            内容合规预筛（NFKC + 紧凑形态 + 词表热重载）
   └─ rate-limit.js            进程内固定窗口限流
```
