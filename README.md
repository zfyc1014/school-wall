# 校园表白墙

匿名校园社区。前端 **Vite + React**，后端 **Node 内置 http + SQLite(WAL)**，
带 **Cloudflare Turnstile 人机验证**、**后台实名（手机号）** 与 **先审后发**，
面向**最低配置 VPS / 香港部署**。

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│  React 前端 (web/)          │  /api  │  后端 (server/)          │
│  Vite · 零运行时依赖         │ ─────► │  node:http + SQLite WAL  │
│  构建产物 → web/dist/        │        │  先审后发 · 限流 · 实名    │
└─────────────────────────────┘        └───────────┬──────────────┘
        ▲                        ┌──────────────────┴───────────────┐
        │                        ▼                                  ▼
   /admin 审核后台         Cloudflare Turnstile                短信通道
   （单文件，后端直供）       （你在不在）                    （你是谁）
```

**两道人机/实名闸门回答的是两个不同的问题**：
Turnstile 回答「你不是脚本」，手机号实名回答「出事时能找到你」。写操作两者都要过。

| 路径 | 说明 |
| --- | --- |
| `web/` | React 源码（Vite 工程） |
| `index.html` | Vite 入口（必须在 Vite root 即仓库根下） |
| `server/` | Node 后端：API、SQLite schema、限流、合规预筛、人机验证、实名、审核后台 |
| `server/public/admin.html` | **审核后台**（单文件，无需构建，访问 `/admin`） |
| `school-confession-wall.html` | 原始单文件原型，保留未改动 |
| `DESIGN.md` | 设计系统契约与实现映射 |
| `DEPLOY.md` | **上线配置与运维手册（先读这个）** |
| `scripts/` `server/scripts/` | 端到端测试与数据库自检（零依赖，不需要装测试框架） |

---

## 1. 三条命令

```bash
npm install          # 前端依赖（react / vite）
npm run dev          # 开发预览 → http://127.0.0.1:5173
npm run build        # 生产构建 → web/dist/
```

预览与验证：

```bash
npm run preview      # 预览构建产物 → http://127.0.0.1:4173
npm run smoke        # 前端端到端（无头浏览器，44 项）
npm run smoke:api    # 前端 × 后端契约（假后端，13 项）
npm run e2e          # 生产模式全链路（真后端 + 真产物 + 无头浏览器，47 项）
npm run server:test  # 后端接口 29 + 数据库自检 53 + 实名与先审后发 52
npm run tokens       # 设计令牌与原型一致性（53/53）
npm run verify       # 以上全部串跑一遍
```

> **Windows 提示**：本机 PowerShell 的执行策略禁止运行 `npm.ps1`。
> 用 `cmd /c "npm run dev"`，或在 cmd 里执行。

### 只跑前端（不需要后端）

前端启动时探测 `/api/health`：

- 成功 → 走真实后端，页脚显示「已连接后端 API · 内容先审后发」
- 失败 → 回落本地演示数据，页脚显示「后端连接失败 · 已回落到本地演示数据」

**生产环境请用 `VITE_DATA_MODE=api`**，这样连不上后端会直接报错，
而不是静默回落到演示数据 —— 见 `.env.production.example`。

```bash
VITE_DATA_MODE=auto    # 开发预览：优先 /api，失败回落本地
VITE_DATA_MODE=api     # 生产：强制后端，不回落
VITE_DATA_MODE=local   # 纯前端演示
```

---

## 2. 前后端一起跑（真实数据）

```bash
# 终端 A —— 后端
cd server
npm install                                     # 需要 better-sqlite3（原生模块）
cp .env.example .env                            # 改 ADMIN_TOKEN / IP_HASH_SECRET / Turnstile 密钥
node --env-file=.env src/server.js              # Node 20+；监听 127.0.0.1:8080

# 终端 B —— 前端
npm run dev                                     # 5173，/api 自动代理到 8080
```

前端 dev/preview 已内置代理，浏览器里 `fetch('/api/...')` 直接命中后端，**无需 CORS**。
后端不在 8080 时用 `OD_API_TARGET=http://127.0.0.1:9000 npm run dev` 覆盖。

生产部署（Turnstile 密钥、Caddy + systemd、备份、数据库维护、回滚）全部写在 **`DEPLOY.md`**。

---

## 3. 后台实名（前台匿名）

**为什么要做**：内容可以匿名展示，但平台必须收集并验证发布者的身份标识 ——
这是出事时能证明「我采取了措施」的唯一凭据，也是法律要求。

| 环节 | 做法 |
| --- | --- |
| 收集 | 发布 / 评论 / 举报前强制验证手机号（中国大陆 +86 / 香港 +852） |
| 验证 | 6 位短信验证码，10 分钟有效、**一次性**、错 5 次作废 |
| 存储 | **只存 HMAC-SHA256 哈希 + 脱敏号码**（`86 13****00`），不存明文号码 |
| 留痕 | 记录同意条款版本与时间，便于说明「当时的同意范围」 |
| 追溯 | 管理接口按身份反查该号码发布过的**全部**内容（含待审与已下架） |
| 闸门 | **服务端强制**：没有实名会话的写请求一律 `403 identity_required` |

三个刻意的取舍：

1. **不拦截阅读。** 表白墙读多写少；把浏览挡在手机号后面会显著伤害可用性，
   而有法律风险的是「发布」。需要全站实名时设 `IDENTITY_REQUIRE_FOR_READS=1`。
2. **不是账号系统。** 没有密码、昵称、个人主页、跨设备登录 ——
   只有一个已验证的身份标识。防「一人多号」只能靠短信通道侧的号码实名 + 应用层限频。
3. **发码接口先过人机验证。** 否则它本身就是一个现成的短信轰炸器（已有测试覆盖）。

短信通道**可插拔**（`server/src/sms.js`），因为通道选择差别很大：

| `SMS_PROVIDER` | 用途 | 注意 |
| --- | --- | --- |
| `log` | 本地开发 | 验证码只写日志；生产会**拒绝启动**，除非显式放行 |
| `webhook` | 自建中转对接任意通道 | POST `{phone, code, text}` 到你的网关 |
| `twilio` | 国际通道，香港可用 | +86 号码到达率需实测 |

⚠️ **+86 短信的现实约束**：境内通道普遍要求企业资质 + 模板报备，且常需域名/服务器
**ICP 备案**。香港服务器 + 未备案域名通常拿不到 +86 发送权限 —— 详见 `DEPLOY.md` 第 0 节。

---

## 4. 先审后发

**帖子与评论都必须是 `pending`，人工审核通过后才公开。** 不接受「发布后审核」
或「只靠举报」—— 那正是被处罚的模式。

| 内容 | 默认状态 | 公开条件 |
| --- | --- | --- |
| 帖子 | `pending` | 管理员 `approve` 后才出现在 `GET /api/posts` |
| 评论 | `pending` | 管理员 `approve` 后才出现在帖子下，且**此时**才计入 `comment_count` |

> 评论原先的实现是「命中规则才转人工、否则直接公开」，属于发布后审核。
> 现在规则命中（`flag`）只是给审核员多一个提示，不改变「必须先审」。

### 审核后台：`/admin`

由后端直接提供的单文件后台（`server/public/admin.html`，无需构建），四个工作区：

- **待审帖子 / 待审评论**：逐条通过或驳回，可填审核意见（写入 `review_note` 留痕）；
  队列项显示发布者的**脱敏号码**，一眼看出这条能不能追溯到人
- **举报工单**：下架内容或驳回举报（通知—移除机制）
- **实名身份**：身份列表 + 「追溯」按钮，一键查看该身份发过的全部内容

访问控制很重要 —— 推荐**不暴露到公网**，用 SSH 隧道访问：

```bash
ssh -L 8080:127.0.0.1:8080 user@your-vps   # 然后本机打开 http://127.0.0.1:8080/admin
```

（`DEPLOY.md` 第 6 节给了另一种做法：反代层按来源 IP 放行。）

---

## 5. 人机验证（Cloudflare Turnstile）

**为什么选它**：免费、不跟踪用户、对国内访客可达，而且对低配 VPS 极友好 ——
只有「首次验证」会出网一次，通过后本服务签发短期会话 cookie，后续请求不再往返 Cloudflare。

三层设计：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 入口闸门 | 前端首屏 | 未验证时弹层提示；允许「暂不验证，仅浏览」（读多写少，不必挡阅读） |
| 发布闸门 | 发布抽屉内联 widget | 提交前拿一次性 token，随写请求一起发出 |
| **服务端闸门** | `server/src/challenge.js` | 发帖/评论/举报/点赞全部强制校验，**前端按钮不算数** |

关键点：

- **服务端强制**：直接 `curl` 打 API 会被 `403 challenge_required` 拦下（已测）。
- **会话复用**：Turnstile token 一次性、5 分钟过期；验证通过后签发 `HttpOnly` 会话 cookie
  （默认 30 分钟），绑定 IP 哈希，复制到别的网络环境即失效。
- **生产拒绝裸奔**：`NODE_ENV=production` 且未配置 Turnstile 时**拒绝启动**（退出码 1），
  除非显式设置 `CHALLENGE_ALLOW_DISABLED=1`。
- **隐私**：不落盘原始 IP；回传 Cloudflare 的 IP 优先取 `CF-Connecting-IP`；
  cookie 里只有「过期时间 + HMAC 签名」。请把 Turnstile 这一项数据处理写进隐私政策
  （Cloudflare 提供 [Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/)）。
- **CSP 已放行** `script-src` / `frame-src` 的 `https://challenges.cloudflare.com`，
  否则 widget 加载不出来。见 [官方 CSP 要求](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)。

配置项与调优建议见 `server/.env.example`；取值与校验流程依据
[Cloudflare 官方 Siteverify 文档](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。

---

## 6. 数据库优化（低配 VPS）

这一轮的改动集中在这里，每一项都针对「1 vCPU / 1GB 内存 + 网络盘」的实际瓶颈：

| 问题 | 原来 | 现在 |
| --- | --- | --- |
| **启动卡住数秒** | 每次启动全表重算 `like_count`（每行一次子查询） | 只在崩溃恢复或距上次超过 7 天时校准；干净退出会写标记 |
| **首屏查询退化** | 建了索引，但优化器收集统计信息后改判「全表扫描更便宜」 | 索引覆盖查询列 + 关闭 `auto_analyze`，计划在任何统计信息下都稳定 |
| **翻页排序开销** | `(like_count < ? OR (like_count = ? AND id < ?))` 触发 MULTI-INDEX OR + 临时 B 树 | 行值元组比较 `(like_count, id) < (?, ?)`，一次索引区间扫描 |
| **WAL 无限增长** | 只在退出时 checkpoint | 启动 + 每 5 分钟 TRUNCATE checkpoint |
| **表无限膨胀** | 无保留期清理 | 启动/每 6 小时清孤儿行；`RETENTION_DAYS` 可选清理历史数据与日志 |
| **索引冗余** | 部分索引与全表索引前缀重复 | 8 个索引全部有明确查询对应，自检脚本锁死数量 |
| **缓存固定 4MB** | 写死 `-4000` | 按机器内存自动定档（16/32/64MB），`DB_CACHE_MB` 可覆盖 |
| **并发首屏各查一次** | 无缓存 | 3 秒短时缓存 + ETag 条件请求（304） |
| **计数漂移** | 驳回已通过的评论时 `comment_count` 只增不减 | 审核动作同步加减，`MAX(0, …)` 兜底 |

自检脚本把这些变成可断言项：

```bash
cd server
npm run test:db      # 47 项：结构 / 查询计划（ANALYZE 前后各一遍）/ 计数一致性 / 清理 / 退出标记
npm run db:check     # 针对真实 data/wall.db 只读体检
npm run db:recount   # 手动全量校准点赞计数
```

---

## 7. 验证怎么做的

全部测试零依赖（不需要 Jest/Playwright），用 Node 内置能力 + 无头 Edge：

| 命令 | 覆盖 | 项数 |
| --- | --- | --- |
| `npm run smoke` | 首屏结构、令牌生效、数据源回落、排序、点赞、筛选、搜索、发布校验、举报、Esc、移动端单列与 44px 触摸目标、无横向滚动、reduced-motion | 44 |
| `npm run smoke:api` | 探测走 http 适配器、信息流来自后端、点赞用服务端计数、发布体正确、先审后发、评论按需拉取 | 13 |
| `npm run server:test` | 见下三行 | 29 + 53 + 52 |
| ├ `server/scripts/api-test.js` | keyset 分页（不重不漏、跨页有序、旧游标兼容）、ETag 304、**人机验证闸门**（无凭据 403 / 有效 token 换会话 / 校验失败 403 / 缺 token）、先审后发、管理鉴权、CSP 头 | 29 |
| ├ `server/scripts/db-check.js` | 表与索引清单、13 条关键查询的 `EXPLAIN QUERY PLAN`（**ANALYZE 前后各断言一遍**）、计数一致性、级联与保留期清理、干净退出标记 | 53 |
| └ `server/scripts/identity-test.js` | **后台实名与先审后发**：手机号归一化与校验、未实名 403、完整验证流程、验证码一次性/错次上限/重发冷却/限流、**明文号码不落库**、帖子与评论先审后发、身份追溯链路、生产环境短信通道守卫 | 52 |
| `npm run e2e` | **生产模式全链路**：启动守卫、真后端提供构建产物、两道人机/实名闸门、直连 API 被拦、验证后解锁、发布进审核队列、**审核后台界面实际操作**、安全头与缓存策略 | 47 |

`npm run e2e` 用 Cloudflare 官方**测试密钥**（`1x…AA` 恒通过 / `2x…AA` 恒失败）
配合 `VITE_CHALLENGE_TEST_MODE=1`，因此无头浏览器也能走完「验证 → 解锁 → 发布」；
实名的短信则走 `SMS_PROVIDER=log`，测试从服务端日志取验证码，
**因此整条链路不需要真的发短信、也不依赖外部网关**。生产构建不会带这个开关。

有几个断言值得一提，它们抓出过真 bug：

- **明文号码不落库**：直接查库确认 `identities` 里只有哈希与脱敏号码
- **审核后台真的能用**：在无头浏览器里输入令牌登录、点「通过」，再确认内容对外公开
- **陌生访客被拦**：用独立浏览器上下文（不共享 cookie）验证闸门对新访客照样生效
- **查询计划在 ANALYZE 前后都要走索引**：防止统计信息一更新就退化成全表扫描

截图产出于 `web/screenshots/`（桌面 1440px、手机 375px）。

---

## 8. 上线前必做

1. 按 **`DEPLOY.md`** 逐条配置：Turnstile 密钥、**短信通道**、`ADMIN_TOKEN`、
   `IP_HASH_SECRET`、`IDENTITY_SECRET`（**上线后不可更改**）、`WEB_ROOT` 指向
   `web/dist`、Caddy + systemd。
2. **限制 `/admin` 的访问来源**（推荐 SSH 隧道，不暴露公网）。
3. `server/data/banned.txt` 换成经审阅的词库。
4. 免责声明里的 `report@example.edu`、示例校名、版本日期换成真实信息；
   隐私政策需覆盖 UGC、**手机号哈希的收集目的与保留期**、「匿名不等于无资料」、
   Turnstile 与短信通道两个第三方的参与、查阅/更正渠道；**交香港执业律师审阅**。
5. 考虑开启 `RETENTION_DAYS=90`（合规上通常需要明确的保留期限）。
6. 配好备份：`sqlite3 wall.db ".backup"` 或先 checkpoint 再打包 `server/data/`。
   注意备份里含有身份哈希 —— 按个人资料同等级别保护。

> 本文件、`DEPLOY.md`、`DESIGN.md` 与前端免责声明均为工程模板，**不构成法律意见**。
