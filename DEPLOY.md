# 上线部署与运维

面向**最低配置 VPS（1 vCPU / 1GB 内存）**、**香港部署**、**带 Cloudflare Turnstile 人机验证**
的完整上线清单。按顺序做即可；每一步都标了「为什么」。

> 本文是工程与运维说明，**不构成法律意见**。免责声明、隐私政策与内容处置流程请由具备
> 香港执业资格的律师审阅。

---

## 0. 上线前必须拿到的三样东西

| 东西 | 从哪来 | 记到哪里 |
| --- | --- | --- |
| Turnstile **Site Key** | [Cloudflare 控制台](https://dash.cloudflare.com) → Turnstile → 添加站点 | `TURNSTILE_SITE_KEY`（可公开，会下发给浏览器） |
| Turnstile **Secret Key** | 同上，创建 widget 时一起给出 | `TURNSTILE_SECRET`（**机密**，只放服务端） |
| 两个随机密钥 | `openssl rand -hex 32` ×2 | `ADMIN_TOKEN`、`IP_HASH_SECRET` |

创建 Turnstile widget 时：

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

TURNSTILE_SITE_KEY=<你的 sitekey>
TURNSTILE_SECRET=<你的 secret>
CHALLENGE_ENFORCE=1
TURNSTILE_HOSTNAMES=wall.example.edu
CHALLENGE_TTL=1800

ADMIN_TOKEN=<openssl rand -hex 32>
IP_HASH_SECRET=<另一次 openssl rand -hex 32>

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

# 2) 人机验证已启用，并下发了 sitekey
curl -s https://wall.example.edu/api/challenge/config
#   期望 {"enabled":true,"required":true,"siteKey":"0x4AAA...","verified":false}

# 3) 绕过前端直接发帖，必须被拦（这是最关键的一条）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://wall.example.edu/api/posts \
  -H 'content-type: application/json' \
  -d '{"cat":"表白","body":"这条不该被写进去，应该被 403 拦下"}'
#   期望 403

# 4) 安全头
curl -sI https://wall.example.edu/ | grep -i -E 'content-security-policy|strict-transport|x-content-type'

# 5) 管理接口未鉴权应 401
curl -s -o /dev/null -w '%{http_code}\n' https://wall.example.edu/api/admin/stats
#   期望 401
```

浏览器里再走一遍：首屏出现验证弹层 → 完成验证 → 能发布 → 提示「等待审核」→
审核通过后才出现在墙上。

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

# 审核（管理界面刻意不在前端暴露，用 API 或内部工具）
curl -s localhost:8080/api/admin/queue?type=posts -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/api/admin/posts/12/approve -H "Authorization: Bearer $TOKEN"

# 回滚前端：重新构建上一个 commit 即可（后端 API 未变，前端可独立回滚）
cd /srv/confession-wall && git checkout <上一个可用 commit> && VITE_DATA_MODE=api npm run build
```

---

## 9. 上线后建议观察一周

| 指标 | 从哪看 | 关注点 |
| --- | --- | --- |
| 待审队列长度 | `/api/admin/stats` | 持续增长说明没人审，或规则误伤太多 |
| 数据库体积 / WAL | 同上 `db.fileBytes` / `db.walBytes` | WAL 持续 > 20MB 说明 checkpoint 未生效 |
| 验证失败率 | Cloudflare 控制台 → Turnstile Analytics | 突然升高可能是 sitekey/hostname 配错 |
| 内存占用 | `systemctl status` | 接近 `MemoryMax` 就需要上 swap 或降 `DB_CACHE_MB` |
| 举报工单 | `/api/admin/reports?status=open` | 通知—移除机制要求尽快核查 |

低配机器的两条保险：**加 1GB swap**（防 Node 尖峰 OOM），
**把静态资源交给 CDN/Cloudflare 缓存**（源站只处理动态请求）。

---

## 10. 合规收尾（香港）

- 隐私政策需覆盖：收集什么（哈希后的 IP、UA 哈希、内容）、为什么（反滥用、举报核查、
  安全审计）、保留多久（`RETENTION_DAYS`）、如何查阅/更正、以及 **Cloudflare Turnstile
  作为第三方服务的参与**（其对验证过程的处理见 Cloudflare 自己的隐私附录）。
- 「匿名不等于无资料」要写清楚：前台不展示身份，但技术上保留了不可逆哈希与时间戳。
- `banned.txt` 换成经审阅的词库；`server/src/moderation.js` 的结构性规则按校情调整
  （命中即转人工，不自动删除，避免误伤）。
- 起底（doxxing）刑事化后，联系方式类内容必须在公开前拦下转人工 —— 现有规则已覆盖，
  但要有人真的去看队列。
- 上线前把 `report@example.edu`、示例校名、模板版本日期全部替换为真实信息。

> 以上为工程实践提示，**不是法律意见**。请由具备香港执业资格的律师审阅后再上线。
