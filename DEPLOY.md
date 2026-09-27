# 上线部署与运维

面向**最低配置 VPS（1 vCPU / 1GB 内存）**、**香港部署**、**带 Cloudflare Turnstile 人机验证
与后台实名（手机号）+ 先审后发**的完整上线清单。按顺序做即可；每一步都标了「为什么」。

> 本文是工程与运维说明，**不构成法律意见**。免责声明、隐私政策与内容处置流程请由具备
> 香港执业资格的律师审阅。

---

## 合规基线：两条不能省的措施

这两条不是产品偏好，而是「出事时能证明平台采取了措施」的唯一凭据。

### ① 后台实名 —— 前台匿名，后台可追溯

**要求**：内容可以匿名展示，但平台必须收集并验证发布者的身份标识。
本项目的做法是手机号 + 短信验证码：

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 收集 | 发布/评论/举报前强制验证手机号（中国大陆 +86 / 香港 +852） | `server/src/identity.js` |
| 验证 | 6 位短信验证码，10 分钟有效、一次性、错 5 次作废 | 同上 |
| 存储 | **只存 HMAC-SHA256 哈希 + 脱敏号码**（`86 13****00`），不存明文 | `identities` 表 |
| 留痕 | 记录同意条款版本与时间（`consent_version` / `consent_at`） | 同上 |
| 追溯 | 管理接口按身份反查该号码发布过的**全部**内容（含待审与已下架） | `/api/admin/identity/:id` |
| 闸门 | **服务端强制**：没有实名会话的写请求一律 `403 identity_required` | `requireIdentity()` |

设计上的三个取舍：

- **不拦截阅读。** 表白墙读多写少，把浏览挡在手机号后面会显著伤害可用性；
  有法律风险的是「发布」。若学校或律师要求全站实名，设 `IDENTITY_REQUIRE_FOR_READS=1`。
- **不是账号系统。** 没有密码、昵称、个人主页、跨设备登录 —— 只有一个已验证的身份标识。
  因此防「一人多号」靠的是短信通道侧的号码实名，而不是应用层（应用层只能限频）。
- **匿名不等于免责。** 这句话必须写进隐私政策，也要写进前端告知（已在实名弹层里写明）。

### ② 先审后发 —— 内容与评论都必须先审

**要求**：投稿先进入待审队列，人工过一遍再公开；不要用「发布后审核」或「只靠举报」。

| 内容 | 默认状态 | 公开条件 |
| --- | --- | --- |
| 帖子 | `pending` | 管理员 `approve` 后才出现在 `GET /api/posts` |
| 评论 | `pending` | 管理员 `approve` 后才出现在帖子下，且此时才计入 `comment_count` |

关键点：**评论曾经是「命中规则才转人工、否则直接公开」**——那正是被处罚的那种
「发布后审核」模式。现在两条路径统一为 `pending`，规则命中只是给审核员多一个提示
（`flag` 字段），不改变「必须先审」这一事实。

审核入口：**`/admin`**（由后端直接提供的单文件后台，见第 6 节）。

> 甘肃等地对「未审核即发布」的处罚案例，核心争点正是平台是否建立了事前审核机制。
> 保留审核留痕（`reviewed_at` / `review_note` / `audit_log`）同样重要 ——
> 它证明的不是「内容没问题」，而是「我们确实审过」。

---

## 0. 上线前必须拿到的四样东西

| 东西 | 从哪来 | 记到哪里 |
| --- | --- | --- |
| Turnstile **Site Key** | [Cloudflare 控制台](https://dash.cloudflare.com) → Turnstile → 添加站点 | `TURNSTILE_SITE_KEY`（可公开，会下发给浏览器） |
| Turnstile **Secret Key** | 同上，创建 widget 时一起给出 | `TURNSTILE_SECRET`（**机密**，只放服务端） |
| 短信通道 | 见下方「短信通道怎么选」 | `SMS_PROVIDER` 及其配套变量 |
| 三个随机密钥 | `openssl rand -hex 32` ×3 | `ADMIN_TOKEN`、`IP_HASH_SECRET`、`IDENTITY_SECRET` |

### 短信通道怎么选（这一步最容易卡住）

短信是实名的唯一硬依赖。按你的实际情况选，**没有一种是无条件的**：

| 方案 | 适用 | 代价 / 限制 |
| --- | --- | --- |
| `webhook` + 自建中转 | 已有云账号（阿里云/腾讯云函数等） | 需要自己写中转；中转要能接收 `{phone, code, text}` 并调用通道 API |
| `twilio` | 香港 / 海外号码为主 | 国际短信单价高；中国大陆号码到达率需实测，可能被拦 |
| `log` | **仅本地开发** | 不真发短信，验证码写服务端日志。生产会拒绝启动 |

⚠️ **中国大陆号码（+86）的现实约束**：境内短信通道普遍要求**企业资质 + 短信模板报备**，
且**服务器与域名常需 ICP 备案**。如果你的服务器在香港且没有备案，多数境内通道不会给你开
+86 的发送权限。所以：

- 若用户主要是**香港号码**：Twilio 一类国际通道最省事。
- 若必须覆盖 **+86**：要么走已完成报备的境内通道（需要资质与备案），
  要么换成「邮箱验证」等替代身份标识 —— 那需要改 `identity.js`，
  但请先与律师确认该标识是否满足当地对「真实身份信息」的要求。
- 无论选哪种，**先用小批量真号码实测到达率**再上线。

配置示例（`/etc/confession-wall.env`）：

```ini
IDENTITY_ENFORCE=1
IDENTITY_SECRET=<openssl rand -hex 32>
SMS_PROVIDER=webhook
SMS_WEBHOOK_URL=https://sms-gateway.example.edu/send
SMS_WEBHOOK_TOKEN=<中转服务的鉴权令牌>
```

### 创建 Turnstile widget 时的三个注意点

- **Hostname**：填你的正式域名（`wall.example.edu`）。生产 sitekey 默认只允许该域名，
  也建议显式配置 `TURNSTILE_HOSTNAMES` 做二次校验，避免别人把 sitekey 嵌到别处刷你额度。
- **Widget Mode**：先用 **Managed**（最省心）；流量稳定后可换成 **Non-Interactive** 或
  **Invisible** 减少交互。改完把新的 sitekey/secret 更新到环境变量。
- 不建议把 `localhost` 加入生产 widget 的允许域名 —— 要本地调试就单独建一个测试 widget。

---

## 1. 目录与用户

```bash
sudo mkdir -p /srv/confession-wall
sudo rsync -a --delete --exclude node_modules --exclude .git \
  ./ /srv/confession-wall/
sudo chown -R www-data:www-data /srv/confession-wall
```

前端产物与后端源码同目录，便于 `WEB_ROOT` 直接指向 `web/dist`。

---

## 2. 构建前端

```bash
cd /srv/confession-wall && npm ci
# 生产构建：强制连后端（不回落演示数据）、不带挑战测试模式
VITE_DATA_MODE=api npm run build
```

产物在 `/srv/confession-wall/web/dist/`。改版后重新执行即可（文件名带 hash，可长缓存）。

> `VITE_*` 变量会被打进前端产物，**不要放任何密钥**。Turnstile 的 secret 只在服务端。

---

## 3. 后端依赖与环境变量

```bash
cd /srv/confession-wall/server
sudo -u www-data npm ci --omit=dev     # better-sqlite3 会下载预编译二进制
sudo cp .env.example /etc/confession-wall.env
sudo chmod 600 /etc/confession-wall.env
sudo editor /etc/confession-wall.env
```

`/etc/confession-wall.env` 至少要改这些：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8080
WEB_ROOT=/srv/confession-wall/web/dist
INDEX_FILE=index.html
TRUST_PROXY=1
FORCE_HTTPS=1

# 人机验证（防机器人）
TURNSTILE_SITE_KEY=<你的 sitekey>
TURNSTILE_SECRET=<你的 secret>
CHALLENGE_ENFORCE=1
TURNSTILE_HOSTNAMES=wall.example.edu
CHALLENGE_TTL=1800

# 后台实名（可追溯到人）—— 短信通道见第 0 节
IDENTITY_ENFORCE=1
IDENTITY_SECRET=<第三个 openssl rand -hex 32>
IDENTITY_CONSENT_VERSION=v1.0
IDENTITY_REQUIRE_FOR_READS=0
SMS_PROVIDER=webhook
SMS_WEBHOOK_URL=https://sms-gateway.example.edu/send
SMS_WEBHOOK_TOKEN=<中转鉴权令牌>

# 密钥与数据
ADMIN_TOKEN=<openssl rand -hex 32>
IP_HASH_SECRET=<再一个 openssl rand -hex 32>
DB_PATH=/srv/confession-wall/server/data/wall.db
RETENTION_DAYS=90          # 合规上通常需要明确的保留期限；0 = 不按时间清理
FEED_CACHE_MS=3000
```

**生产启动守卫**：`NODE_ENV=production` 时若没配置 Turnstile 密钥，服务会**拒绝启动**
（退出码 1）并打印原因。这是刻意的 —— 裸奔的写接口会被脚本刷穿。
确有临时需要时用 `CHALLENGE_ALLOW_DISABLED=1`，并在事后尽快补齐密钥。

---

## 4. 反代（Caddy，自动 HTTPS）

```bash
sudo cp /srv/confession-wall/server/deploy/Caddyfile /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile          # 把 wall.example.edu 换成你的域名
sudo systemctl reload caddy
```

Caddyfile 已包含：静态资源直发（省一次 Node 往返）、HSTS/nosniff/Referrer-Policy、
访问日志轮转。`root` 指向 `web/dist`；若仍在用单文件原型，改成 `/srv/confession-wall` 并把
`INDEX_FILE` 换成 `school-confession-wall.html` 即可，两者共用同一套 `/api`。

> 注意：后端 CSP 里已经放行 Turnstile 需要的 `script-src` / `frame-src`
> （`https://challenges.cloudflare.com`）。若你在 Caddy 层再加一层 CSP，
> 必须保留这两个来源，否则验证 widget 加载不出来。

---

## 5. systemd

```bash
sudo cp /srv/confession-wall/server/deploy/confession-wall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now confession-wall
systemctl status confession-wall --no-pager
journalctl -u confession-wall -n 50 --no-pager
```

单元文件要点：

- `EnvironmentFile=/etc/confession-wall.env`（令牌不会出现在 `systemctl status` 里）
- `TimeoutStopSec=15` + `KillSignal=SIGTERM`：给服务时间刷新点赞计数、`PRAGMA optimize`
  并截断 WAL。**这一步很重要** —— 被强杀会被记成「非优雅退出」，
  下次启动会触发全量点赞校准（帖量大时要几秒）。
- `MemoryMax=256M`：超限自动重启，而不是拖垮整机。
- 需要出网访问 `challenges.cloudflare.com`，所以 `RestrictAddressFamilies` 保留 `AF_INET AF_INET6`。

验证：`curl -s https://wall.example.edu/api/health` 应返回 `{"ok":true,...}`。

---

## 6. 上线验收清单

```bash
# 1) 首页能开，且是 React 版（不是单文件原型）
curl -s https://wall.example.edu/ | grep -c 'id="root"'

# 2) 两道人机/实名闸门都已启用
curl -s https://wall.example.edu/api/challenge/config
#   期望 enabled:true 且 identity.required:true，并下发 siteKey

# 3) 绕过前端直接发帖，必须被拦（最关键的一条）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://wall.example.edu/api/posts \
  -H 'content-type: application/json' \
  -d '{"cat":"表白","body":"这条不该被写进去，应该被 403 拦下"}'
#   期望 403（原因 challenge_required 或 identity_required 都算正确）

# 4) 未配置密钥时发短信应被拒（防止接口被当短信轰炸器）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://wall.example.edu/api/identity/request-code \
  -H 'content-type: application/json' -d '{"phone":"13800138000"}'
#   期望 403 challenge_required

# 5) 后台页面可访问（反代层请另行限制来源！）
curl -s -o /dev/null -w '%{http_code}\n' https://wall.example.edu/admin

# 6) 安全头
curl -sI https://wall.example.edu/ | grep -i -E 'content-security-policy|strict-transport|x-content-type'

# 7) 管理接口未鉴权应 401
curl -s -o /dev/null -w '%{http_code}\n' https://wall.example.edu/api/admin/stats
#   期望 401

# 8) 数据库内不应出现明文手机号（隐私底线，务必亲眼确认）
sqlite3 /srv/confession-wall/server/data/wall.db \
  "SELECT id, phone_masked, substr(phone_hash,1,12) FROM identities LIMIT 5;"
#   期望只有形如 "86 13****00" 的脱敏号码，没有 11 位完整号码
```

浏览器里再走一遍完整链路：

1. 首屏出现人机验证弹层 → 完成（或点「暂不验证，仅浏览」）
2. 点「发布告白」→ 提示需要手机号实名 → 填号码 → 收短信 → 完成验证
3. 发布成功 → 提示「等待审核」
4. 打开 `/admin` → 用 `ADMIN_TOKEN` 登录 → 在「待审帖子」里看到这条
   （应显示发布者的脱敏号码）→ 点「通过」
5. 回到首页刷新 → 内容出现在墙上

### 审核后台的访问控制（重要）

`/admin` 是**单文件后台**，由后端直接提供（`server/public/admin.html`）。它自身用
`ADMIN_TOKEN` 调管理接口，所以页面本身不设登录墙 —— 但**你必须限制它的来源**，
否则等于把审核入口暴露在公网：

```caddy
# 方案 A：只允许校园网 / 办公网访问
wall.example.edu {
    @admin path /admin*
    handle @admin {
        @blocked not remote_ip 10.0.0.0/8 203.0.113.7
        respond @blocked 403
        reverse_proxy 127.0.0.1:8080
    }
    # …其余保持原样
}

# 方案 B（更稳）：干脆不在公网暴露，用 SSH 隧道访问
#   ssh -L 8080:127.0.0.1:8080 user@your-vps
#   然后本机打开 http://127.0.0.1:8080/admin
```

推荐方案 B：审核是低频操作，走隧道最省心，也不给公网留任何入口。
另外 `ADMIN_TOKEN` 必须是 ≥32 位随机串，并且定期轮换。

### 另一条独立的上线要求：`IDENTITY_SECRET` 不能改

`IDENTITY_SECRET` 一旦上线就必须长期保持不变 —— 改了它，所有已存的身份哈希都会错位，
老用户需要重新验证，历史内容也再无法关联到发布者。**把它写进密钥备份**，
不要和「随手轮换」的令牌混在一起管理。

---

## 7. 数据库维护（低配 VPS）

数据库是单文件 `server/data/wall.db`（WAL 模式，同目录会有 `-wal` / `-shm`）。

**日常自动做的事**（无需干预）：每 5 分钟 WAL 截断、每 6 小时清孤儿行并刷新统计信息、
退出时标记干净退出 + `PRAGMA optimize` + WAL 截断。

**周期性体检**：

```bash
cd /srv/confession-wall/server
npm run db:check      # 只读体检：体积、页数、可回收空间、各表行数
```

看两个数：

- `reclaimableBytes`（freelist）持续偏大 → 说明删过很多数据但空间没回收
- `walBytes` 持续偏大 → checkpoint 没跟上（一般是长事务或只读连接长期占用）

**回收空间**（需要独占，建议低峰期）：

```bash
sudo systemctl stop confession-wall
sudo -u www-data sqlite3 data/wall.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
sudo -u www-data sqlite3 data/wall.db "PRAGMA optimize;"
sudo systemctl start confession-wall
```

> 建库时如果不是空库，`auto_vacuum` 会是 0（启动日志会提示），此时删除数据不会自动回收，
> 需要上面这条 `VACUUM`。空库首次启动会自动设为 `INCREMENTAL`。

**怀疑点赞数不对**：

```bash
sudo -u www-data node scripts/db-check.js --recount
```

**备份**（推荐用 `.backup`，比直接拷文件安全；拷文件前先 checkpoint）：

```bash
sudo -u www-data sqlite3 data/wall.db ".backup '/var/backups/wall-$(date +%F).db'"
# 只保留最近 14 天
find /var/backups -name 'wall-*.db' -mtime +14 -delete
```

建议放进 crontab 每天凌晨执行，并把备份同步到另一台机器/对象存储。

---

## 8. 常用运维命令

```bash
systemctl restart confession-wall          # 重启（会优雅收尾）
journalctl -u confession-wall -f           # 实时日志
curl -s localhost:8080/api/admin/stats -H "Authorization: Bearer $TOKEN"   # 队列与体积

# 审核：推荐直接用后台界面（需 SSH 隧道或反代放行）
#   ssh -L 8080:127.0.0.1:8080 user@your-vps  →  本机打开 http://127.0.0.1:8080/admin
# 也可以用 API（便于脚本化批量审核）：
curl -s localhost:8080/api/admin/queue?type=posts -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/api/admin/posts/12/approve \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"note":"内容合规，通过"}'
curl -s -X POST localhost:8080/api/admin/comments/34/approve -H "Authorization: Bearer $TOKEN"

# 实名追溯：出事时回答「这个号码发过什么」（含待审与已下架内容）
curl -s localhost:8080/api/admin/identities -H "Authorization: Bearer $TOKEN"
curl -s localhost:8080/api/admin/identity/7 -H "Authorization: Bearer $TOKEN"

# 受控优雅停机（不依赖信号，Windows 上也能用；会写干净退出标记并截断 WAL）
curl -s -X POST localhost:8080/api/admin/shutdown -H "Authorization: Bearer $TOKEN"

# 回滚前端：重新构建上一个 commit 即可（后端 API 未变，前端可独立回滚）
cd /srv/confession-wall && git checkout <上一个可用 commit> && VITE_DATA_MODE=api npm run build
```

---

## 9. 上线后建议观察一周

| 指标 | 从哪看 | 关注点 |
| --- | --- | --- |
| **待审队列长度** | `/api/admin/stats` | 持续增长说明没人审，或规则误伤太多 —— 这是「先审后发」能不能守住的关键 |
| **实名验证量 / 无身份记录数** | 同上 `verifiedIdentities` / `postsWithoutIdentity` | 后者应停在实名制上线前的历史数据上，不再增长 |
| 短信发送失败率 | `journalctl -u confession-wall`（`[sms]` 前缀） | 通道欠费或被限流会直接堵死发布 |
| 数据库体积 / WAL | `db.fileBytes` / `db.walBytes` | WAL 持续 > 20MB 说明 checkpoint 未生效 |
| 人机验证失败率 | Cloudflare 控制台 → Turnstile Analytics | 突然升高可能是 sitekey/hostname 配错 |
| 内存占用 | `systemctl status` | 接近 `MemoryMax` 就需要上 swap 或降 `DB_CACHE_MB` |
| 举报工单 | `/api/admin/reports?status=open` | 通知—移除机制要求尽快核查 |

低配机器的两条保险：**加 1GB swap**（防 Node 尖峰 OOM），
**把静态资源交给 CDN/Cloudflare 缓存**（源站只处理动态请求）。

### 已知问题：Windows 上的原生断言（不影响 Linux 生产）

在 Windows 开发机上，**带活跃 better-sqlite3 连接调用 `process.exit()`** 会偶发触发
Node 的原生断言（`RemoveEnvironmentCleanupHook` / `Statement` 析构），进程以
SIGABRT(134) 结束。表现是「服务偶发崩溃」，且发生在启动/收尾附近而不是请求处理中。

已做的规避（都在代码里）：

- 服务端优雅停机改为**设置 `process.exitCode` 后自然退出**，不再强制 `process.exit()`
- 所有致命错误路径（配置缺失等）先同步写日志 → 关库 → 再退出
- 提供 `POST /api/admin/shutdown` 作为不依赖信号的收尾入口
  （Windows 的 `child.kill("SIGTERM")` 不会触发 JS 信号处理器）

**Linux + systemd 不受影响**：信号处理器正常工作，收尾会写入干净退出标记、
执行 `PRAGMA optimize` 并截断 WAL。若你在 Windows 上看到这个崩溃，
重启即可，它不会损坏数据库（WAL 保证了写入原子性）。

---

## 10. 合规收尾（香港）

- 隐私政策需覆盖：收集什么（**手机号的不可逆哈希**与脱敏形式、哈希后的 IP、UA 哈希、
  内容）、为什么（**身份验证与依法配合调查**、反滥用、举报核查、安全审计）、
  保留多久（`RETENTION_DAYS`）、如何查阅/更正，以及两个第三方服务的参与：
  **Cloudflare Turnstile**（人机验证）与**短信通道**（验证码下发）。
- 必须写清「**匿名不等于无资料**」：前台不展示身份，但平台按法律要求收集并验证了
  身份标识；同时说明前台匿名展示的具体范围（不展示号码、不展示账号）。
- **同意义务**：收集手机号前必须有明确同意，且留痕。本项目已在实名弹层给出告知，
  并把 `consent_version` / `consent_at` 写入 `identities` 表；修改告知文案后请同步提升
  `IDENTITY_CONSENT_VERSION`，新旧版本会同时留档，便于说明「当时的同意范围是什么」。
- **保留期限**：手机号哈希属于个人资料，应设定明确保留期并在政策中说明。
  被拒内容与已结案工单建议 `RETENTION_DAYS=90` 自动清理。
- **查阅 / 更正 / 删除**：需在政策中给出渠道（如 `report@example.edu`），
  并确保运营方真的能按 `phone_masked` + 时间定位到记录（见第 8 节的追溯命令）。
- `banned.txt` 换成经审阅的词库；`server/src/moderation.js` 的结构性规则按校情调整
  （命中只做提示，不改变「必须先审」这一流程）。
- 起底（doxxing）刑事化后，联系方式类内容必须在公开前拦下转人工 —— 规则已覆盖，
  但**先审后发**才是真正的兜底：要有人真的每天看队列。
- 上线前把 `report@example.edu`、示例校名、模板版本日期全部替换为真实信息。

> 以上为工程实践提示，**不是法律意见**。请由具备香港执业资格的律师审阅后再上线。
> 尤其是「手机号是否满足当地对真实身份信息的要求」以及「保留期限是否合规」两项，
> 应当以律师意见为准，而不是本文的默认配置。
