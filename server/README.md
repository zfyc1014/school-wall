# 校园表白墙 · 后端

面向**最低配置 VPS**（1 vCPU / 1GB RAM 级别）与**香港部署**场景的后端服务。
前端有两个：React 版（`web/` 的 Vite 工程，构建到 `web/dist/`）与保留未改动的
单文件原型 `school-confession-wall.html`。两者共用本服务的 `/api`，见第 4 节。

> 本文件是工程与部署说明，**不构成法律意见**。上线前请由具备香港执业资格的律师审阅免责声明、隐私政策与内容处置流程。

---

## 1. 技术选型与理由

| 决策 | 选择 | 为什么适合低配 VPS |
| --- | --- | --- |
| HTTP 框架 | Node 内置 `http` | 无框架开销，常驻内存约 40–60MB |
| 数据库 | SQLite（WAL 模式） | 单文件、无独立进程，省下一整份数据库内存 |
| 分页 | keyset（游标）分页 | 行值元组比较走索引区间扫描，深翻页不扫全表 |
| 点赞写入 | 内存队列 + 定时批量回写 | 把多次 fsync 合并成一次事务 |
| 人机验证 | Cloudflare Turnstile | 只有首次验证出网一次，之后走本地会话；免费、不跟踪用户 |
| TLS | Caddy / Nginx 终止 | 低配机器不承担 TLS 握手 CPU |
| 缓存 | 3 秒内存缓存 + ETag + CDN | 并发首屏合并为一次查询，重复请求回 304 |
| 限流 | 进程内固定窗口 | 免去 Redis 的额外内存与运维 |

数据流：`浏览器 → Caddy(TLS/静态) → Node(动态 API) → SQLite(WAL)`，
其中写请求在进入业务逻辑前先过人机验证闸门（首次需往返 Cloudflare）。

---

## 2. 快速开始

```bash
cd server
npm install
cp .env.example .env          # 按需修改
node --env-file=.env src/server.js   # Node 20+；Node 18 用 dotenv 或直接 export
```

启动后访问 `http://127.0.0.1:8080/`，默认首页为 `school-confession-wall.html`；
若已 `npm run build` 过 React 版，把 `WEB_ROOT` 指到 `web/dist`、`INDEX_FILE` 设为
`index.html` 即可改由 React 版对外（第 4 节）。
生产环境建议直接写入 `/etc/confession-wall.env` 并由 systemd 加载（见 `deploy/`）。

> Node 18 没有 `--env-file`：用 `set -a; . ./.env; set +a; node src/server.js`。

### 关键环境变量

| 变量 | 说明 |
| --- | --- |
| `HOST` / `PORT` | 默认 `127.0.0.1:8080`，只监听回环，由反代对外 |
| `WEB_ROOT` | 静态根目录，React 版指向 `web/dist` |
| `INDEX_FILE` | 默认首页文件名（React 版 `index.html`） |
| `DB_PATH` | SQLite 路径，默认 `server/data/wall.db` |
| `ADMIN_TOKEN` | 管理接口令牌，**≥ 24 字符随机串**（`openssl rand -hex 32`） |
| `IP_HASH_SECRET` | IP 哈希密钥，不落盘原始 IP |
| `TRUST_PROXY` | 反代后置 `1`，用于读取 `X-Forwarded-For` / `CF-Connecting-IP` |
| `MAX_BODY` | 请求体上限，默认 32KB（图片走对象存储直传，不经这里） |
| `PAGE_MAX` | 单页最大条数，默认 30 |
| `LIKE_FLUSH_MS` | 点赞计数回写间隔，默认 1500ms |
| `BANNED_FILE` | 合规词表路径，默认 `data/banned.txt` |

### 人机验证（Cloudflare Turnstile）

| 变量 | 说明 |
| --- | --- |
| `TURNSTILE_SITE_KEY` | 前端 widget 的 sitekey（可公开，会下发给浏览器） |
| `TURNSTILE_SECRET` | **机密**，服务端校验用；未配置则人机验证整体关闭 |
| `CHALLENGE_ENFORCE` | `1` 强制 / `0` 关闭；默认 = 生产且已配置密钥时开启 |
| `TURNSTILE_HOSTNAMES` | 允许的 hostname 白名单（逗号分隔），建议至少配这个 |
| `TURNSTILE_ACTIONS` | 允许的 action 白名单（逗号分隔），留空不校验 |
| `CHALLENGE_TTL` | 验证通过后会话有效期（秒），默认 1800 |
| `CHALLENGE_FAIL_OPEN` | Cloudflare 不可达时是否放行，默认 `0`（拒绝） |
| `CHALLENGE_COOKIE_SECURE` | 会话 cookie 是否仅 HTTPS；生产默认开 |
| `CHALLENGE_ALLOW_DISABLED` | 逃生开关：允许生产在未配置验证的情况下启动 |

**生产启动守卫**：`NODE_ENV=production` 且未配置 Turnstile 时，
服务会打印原因并以退出码 1 退出（而不是裸奔运行）。

### 数据库调优与维护

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_CACHE_MB` | 按内存自动 | 页缓存 MB：≤1GB→16，≤2GB→32，否则 64 |
| `DB_CHECKPOINT_MS` | 300000 | WAL 截断间隔（防 `-wal` 无限增长） |
| `DB_CLEANUP_MS` | 21600000 | 保留期清理 + `PRAGMA optimize` 间隔 |
| `RETENTION_DAYS` | 0 | `0` 只做结构性清理；`>0` 额外清理超期被拒内容、已结案工单、审计日志 |
| `DB_RECOUNT_ON_BOOT` | 0 | `1` 强制启动时全量校准点赞计数 |
| `DB_RECOUNT_DAYS` | 7 | 距上次校准超过该天数则校准一次 |
| `FEED_CACHE_MS` | 3000 | 信息流短时缓存（毫秒），`0` 关闭 |

详见根目录 `DEPLOY.md` 第 7 节（数据库维护）与第 9 节（上线后观察）。

---

## 3. API

所有响应为 JSON。写接口按 IP 哈希限流，超限返回 `429` 与 `retryAfter`（秒）。

### 公开接口

```
GET  /api/health
GET  /api/challenge/config           人机验证配置 + 当前会话是否已验证
POST /api/challenge/session          用一次性 token 换会话 cookie  { "token": "…" }
POST /api/challenge/logout           结束会话
GET  /api/posts?cat=表白&sort=new|hot&q=关键词&cursor=<游标>&limit=20
POST /api/posts                      { "cat": "表白", "body": "…" }        ← 需验证
POST /api/posts/:id/like             幂等切换，同一 IP 再点即取消            ← 需验证
GET  /api/posts/:id/comments
POST /api/posts/:id/comments         { "body": "…" }                       ← 需验证
POST /api/reports                     { "postId": 12, "reason": "…" }       ← 需验证
```

**所有写接口都要求人机验证**（服务端强制，不依赖前端）：

- 带上会话 cookie（`POST /api/challenge/session` 签发，默认 30 分钟），或
- 直接带一次性 token：请求头 `CF-Turnstile-Response: <token>`

缺少凭据时返回 `403 {"error":"challenge_required"}`；
token 无效/过期返回 `403 {"error":"verify_failed"|"token_expired"}`；
Cloudflare 不可达时按 `CHALLENGE_FAIL_OPEN` 决定返回 `503`（默认，拒绝）或放行。

列表响应带 `ETag`，客户端可用 `If-None-Match` 拿到 `304`（省掉一次查询与 gzip）。

游标分页：返回 `nextCursor`，下次请求原样带回；为 `null` 表示到底。
`sort=new` 游标为 `created_at.id`，`sort=hot` 游标为 `like_count.id`
（都用行值元组比较翻页，一次索引区间扫描；同时兼容旧版纯 `id` 游标）。

```bash
curl -s 'http://127.0.0.1:8080/api/posts?sort=hot&limit=20'
# 带一次性 token 发帖（token 从 Turnstile widget 拿到）
curl -s -X POST http://127.0.0.1:8080/api/posts \
  -H 'content-type: application/json' \
  -H 'CF-Turnstile-Response: <token>' \
  -d '{"cat":"表白","body":"想对图书馆三楼的你说句话…"}'
```

发布后 `status` 为 `pending`，**先审后发**；审核通过才会出现在 `GET /api/posts`。

### 管理接口（需鉴权）

鉴权：`Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token: <ADMIN_TOKEN>`。

```
GET  /api/admin/stats
GET  /api/admin/queue?type=posts|comments&limit=50
POST /api/admin/posts/:id/approve | reject | remove
POST /api/admin/comments/:id/approve | reject
GET  /api/admin/reports?status=open|actioned|dismissed|all
POST /api/admin/reports/:id/resolve  { "action": "takedown" | "dismiss" }
```

```bash
TOKEN=$(openssl rand -hex 32)   # 与 .env 中一致
curl -s http://127.0.0.1:8080/api/admin/queue?type=posts \
  -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:8080/api/admin/posts/12/approve \
  -H "Authorization: Bearer $TOKEN"
```

管理界面**不在前端暴露**：前端原型已移除全部审核入口，审核通过内部工具或上述 API 完成，
避免把管理路径暴露给普通访客。每次处置都会写入 `audit_log` 留痕。

---

## 4. 把前端接到后端

仓库里有两个前端，**共用同一套 `/api`**，静态服务只认 `WEB_ROOT` + `INDEX_FILE`：

| 前端 | 入口 | 说明 |
| --- | --- | --- |
| React 版（推荐） | `web/dist/index.html` | `web/` 的 Vite 产物，已内置数据源探测与回落 |
| 单文件原型 | `school-confession-wall.html` | 保留未改动的视觉基线，`localStorage` 演示数据 |

```bash
npm run build                                  # 仓库根执行，产物落在 web/dist/
# server/.env
WEB_ROOT=/srv/confession-wall/web/dist
INDEX_FILE=index.html
```

想继续对外提供单文件原型，把 `INDEX_FILE` 改回 `school-confession-wall.html` 即可，
不需要改任何代码。Caddy 侧把 `web/dist/assets` 当纯静态目录长缓存分发（见 `deploy/Caddyfile`）。

开发期不需要这样部署：`npm run dev`（在仓库根）已把 `/api` 代理到 `127.0.0.1:8080`，
浏览器里直接 `fetch('/api/...')` 即命中本服务，**无需 CORS**。

### 4.1 React 版如何选择数据源

`web/src/data/adapters.js` 启动时探测 `GET /api/health`（2.5s 超时）：

- 成功 → 使用 http 适配器，页脚显示「已连接后端 API · 内容先审后发」
- 失败 → 回落到 localStorage 演示适配器，页脚显示「后端连接失败 · 已回落到本地演示数据」

用 `VITE_DATA_MODE=auto|api|local` 固定行为（`api` 表示不做静默回落）。
请求字段与上表一致：`{cat, body}` / `{body}` / `{postId, reason}`，响应字段
`items/nextCursor/sort`、`{id,status}`、`{liked,likes}`、`{ok:true}`。

### 4.2 单文件原型的接法（历史方案）

原型的 `renderWall()` 用 `state.posts` 作为数据源，接入真实后端时保留渲染逻辑、
只替换数据来源即可：

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cat, body })
    });
    if (r.status === 429) throw new Error('操作过于频繁，请稍后再试');
    return r.json();
  },
  async like(id) {
    return (await fetch(`/api/posts/${id}/like`, { method: 'POST' })).json();
  },
  async comment(id, body) {
    return (await fetch(`/api/posts/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body })
    })).json();
  },
  async report(postId, reason) {
    return (await fetch('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId, reason })
    })).json();
  }
};
```

映射关系：`renderWall()` 的 `state.posts` ← `GET /api/posts`；
提交弹层 ← `POST /api/posts`；点赞按钮 ← `POST /api/posts/:id/like`；
评论 ← `GET/POST /api/posts/:id/comments`；举报 ← `POST /api/reports`。

因为前端与后端**同源**部署（同一域名），无需配置 CORS，也不引入第三方 JS。

---

## 5. 低配 VPS 调优清单

- **加 swap**：`fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`，
  写入 `/etc/fstab`。SQLite 文件不会很大，swap 主要防 Node 尖峰 OOM。
- **静态走 CDN**：前端产物交给 Cloudflare 等边缘缓存，源站只跑 API。
- **压缩**：Caddy 已开 `zstd gzip`；后端对 ≥1KB 的文本响应自动 gzip。
- **缓存头**：HTML 为 `no-cache`（改版即生效），带指纹的资源为 `max-age=86400`。
- **信息流 ETag + 短时缓存**：重复首屏请求返回 `304`；3 秒内相同查询合并为一次数据库读取。
- **数据库调优**：页缓存按内存自动定档、WAL 定时截断、`PRAGMA optimize` 定期刷新统计信息。
  这些都已内置，不需要手工调；体检与回收命令见根目录 `DEPLOY.md` 第 7 节。
- **内存护栏**：systemd 单元已设 `MemoryMax=256M`，超限自动重启而不是拖垮整机。
- **不引入 Redis/MySQL**：单进程 + SQLite 足够支撑校园级流量；需要横向扩容时再替换
  `rate-limit.js`（接口不变）与迁移到 Postgres。
- **人机验证几乎不增加源站负担**：只有「首次验证」出网一次，之后走本地签发会话。
- **图片**：走对象存储（如 S3 兼容）**前端直传 + 客户端压缩**，源站不落盘原图。
  若必须自存，务必另设子域并禁用该子域的脚本执行，避免 UGC 图片升级为 XSS。

---

## 6. 香港合规要点（工程侧）

> 以下为工程实践提示，**不是法律意见**；具体义务请咨询香港执业律师。

- **个人资料（隐私）条例 · 第 486 章（PDPO）**
  - 数据最小化：本服务**不存储原始 IP**，只存 `HMAC-SHA256(IP)` 前 24 位，仅用于去重与反滥用。
  - 匿名不等于无资料：仍属个人资料处理，需在隐私政策中说明收集目的（举报核查、安全审计）、
    保留期限与查阅/更正渠道。
  - 保留期限：建议 `audit_log`、已结案 `reports`、被拒内容设定期限（如 90 天）自动清理。
- **2021 年修订：起底刑事化**
  - 未经同意披露他人个人资料**并意图造成伤害**可能构成刑事罪行。前端发布公约与后端
    `moderation.js` 的联系方式/身份规则，正是为了把此类内容在公开前拦下转人工。
- **《诽谤条例》第 21 章**：平台采取「通知—移除」，收到有效通知后尽快下架，
  降低发布者与平台的风险敞口；`reports` 表即通知—移除工单。
- **《淫亵及不雅物品管制条例》第 390 章**：涉及不雅内容需及时下架，词表应覆盖相关类别。
- **未成年人**：涉及未成年人的内容优先级更高，应人工复核；建议在公约中加入监护人同意条款。
- **数据出境**：若把数据复制到境外服务商，需评估 PDPO 跨境转移要求；香港本地 VPS 可规避此问题。
- **处置留痕**：`audit_log` 记录管理员动作，便于在争议或执法查询时说明处置过程。

**上线前必做**：把 `school-confession-wall.html` 免责声明中的
`report@example.edu`、示例校名、版本日期替换为真实信息；隐私政策与免责声明交由律师审阅；
`data/banned.txt` 换成经审阅的词库。

---

## 7. 安全清单

- [x] 默认只监听 `127.0.0.1`，由反代终止 TLS
- [x] 全站安全头（CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、HSTS）
- [x] CSP 精确放行 Turnstile 的两个来源（`script-src` / `frame-src`），不多开
- [x] **写接口服务端强制人机验证**（不依赖前端按钮），token 单次有效 + 会话绑定 IP 哈希
- [x] 生产环境未配置人机验证时拒绝启动（退出码 1），避免裸奔
- [x] 管理接口常量时间比对令牌（`timingSafeEqual`）
- [x] 写接口按 IP 哈希限流；管理鉴权失败单独限流；验证校验接口单独限流
- [x] 请求体上限 + JSON 解析失败返回 400
- [x] 静态服务路径穿越防护（`filePath.startsWith(WEB_ROOT + sep)`）
- [x] SQL 全部参数化；搜索用 `LIKE ... ESCAPE` 转义 `% _ \`
- [x] 优雅退出：回写点赞计数、`PRAGMA optimize`、`wal_checkpoint(TRUNCATE)`、写干净退出标记
- [x] 同一 IP 对同一帖的重复举报去重（防止刷爆工单队列）
- [ ] CSP 仍为内联样式放行 `'unsafe-inline'`；进一步加固可提取样式并改用 nonce
- [ ] 生产环境建议在反代层再加一层请求速率与 WAF 规则

---

## 8. 测试

```bash
npm test              # 接口 29 项 + 数据库自检 47 项
npm run test:api      # 只跑接口（真实起服务 + 临时库 + 临时端口）
npm run test:db       # 只跑数据库自检（含 ANALYZE 前后的查询计划对比）
npm run db:check      # 针对真实 data/wall.db 的只读体检
npm run db:recount    # 手动全量校准点赞计数
```

接口测试覆盖：keyset 分页（不重不漏、跨页有序、旧游标兼容）、ETag 304、
人机验证闸门（无凭据 403 / 有效 token 换会话 / 校验失败 403 / 缺 token / CSP 头）、
先审后发与审核流转、管理鉴权。

数据库自检覆盖：表与索引清单（数量写死，防止随手加冗余索引）、
10 条关键查询的 `EXPLAIN QUERY PLAN`（**ANALYZE 前后各断言一遍**）、
点赞/评论计数一致性、级联清理、保留期清理、干净退出标记。

> 测试用 Cloudflare 官方测试密钥（`1x…AA` 恒通过 / `2x…AA` 恒失败）。
> 注意：恒通过的密钥**接受任意 token 字符串**（实测），并不限于官方文档所说的 dummy token；
> 因此「拒绝路径」必须用恒失败的密钥来验证。

---

## 9. 目录结构

```
仓库根/
├─ index.html                Vite 入口（React 版）
├─ package.json / .env.example / .env.production.example
├─ README.md / DESIGN.md / DEPLOY.md
├─ school-confession-wall.html   单文件原型（保留未改动）
├─ web/                      React 前端（Vite）
│  ├─ vite.config.js         root=仓库根、产物→web/dist、/api 代理
│  └─ src/                   components / hooks / data / lib / styles
├─ scripts/                  前端端到端（smoke / api-smoke / prod-e2e）与令牌校验
└─ server/                   本目录
   ├─ package.json
   ├─ .env.example
   ├─ schema.sql              数据库结构（幂等，含索引迁移说明）
   ├─ data/                   SQLite 数据与 banned.txt（勿提交）
   ├─ scripts/
   │  ├─ api-test.js          接口测试（真实起服务）
   │  └─ db-check.js          数据库自检
   ├─ deploy/
   │  ├─ confession-wall.service   systemd 单元
   │  └─ Caddyfile                 反代 + 自动 HTTPS
   └─ src/
      ├─ server.js             HTTP 服务 / 路由 / 静态
      ├─ db.js                 SQLite 连接与调优
      ├─ moderation.js         内容合规预筛
      └─ rate-limit.js         进程内限流
```
