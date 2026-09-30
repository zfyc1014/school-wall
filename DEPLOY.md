# 上线部署与运维 · 校园表白墙 内测版 `0.9.0-beta.1`

面向**最低配置 VPS（1 vCPU / 1GB 内存）**、**香港部署**、**自托管内测门禁 + 先审后发**的完整上线清单。
按顺序做即可；每一步都标了「为什么」。

> **本版本的两个前提**：
> ① 内测阶段**不收集手机号、没有账号体系**，写操作只过「邀请码 + 本地挑战」这道自托管闸门；
> ② **整条链路不需要任何出网请求**（旧版为了 Cloudflare Turnstile 必须能访问境外服务，现在完全内网自洽）。
>
> 本文是工程与运维说明，**不构成法律意见**。免责声明、隐私政策与内容处置流程请由具备香港执业资格的
> 律师审阅。

---

## 0. 上线前检查清单

按顺序勾完再对外开域名：

- [ ] **1. 邀请码**：生成 ≥8 位随机串（`openssl rand -hex 8`），准备好发放名单 —— 它就是内测站的边界。
- [ ] **2. 两个密钥**：`ADMIN_TOKEN`（≥24 字符，建议 `openssl rand -hex 32`）、
      `IP_HASH_SECRET`（≥16 字符）。**生产环境缺失会拒绝启动**。
- [ ] **3. 环境文件**：`/etc/confession-wall.env`，权限 `600`、属主 root（令牌不能出现在 `systemctl status`）。
- [ ] **4. 前端构建**：`VITE_DATA_MODE=api npm run build`，产物在 `web/dist/`。
- [ ] **5. `WEB_ROOT`** 指向 `web/dist`（不要依赖自动探测）。
- [ ] **6. 反代**：Caddy 自动 HTTPS + 静态资源直发；**`/admin` 必须限制来源**（推荐 SSH 隧道）。
- [ ] **7. systemd**：`MemoryMax=256M`、`TimeoutStopSec=15`、`ReadWritePaths` 指向 `server/data`。
- [ ] **8. 词表**：`cp server/data/banned.txt.example server/data/banned.txt` 后换成经审阅的词库。
- [ ] **9. 验收脚本**：跑完第 6 节的上线验收清单（最关键的一条是「直连 API 发帖必须被 403 拦下」）。
- [ ] **10. 备份**：配好 `sqlite3 .backup` 定时任务，并确认能从备份恢复。
- [ ] **11. 合规**：免责声明中的示例邮箱 / 校名 / 版本日期换成真实信息，隐私政策交律师审阅。
- [ ] **12. 观察**：上线后一周按第 9 节的指标盯住待审队列与反馈队列。

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
# 生产构建：强制连后端（不回落演示数据）
VITE_DATA_MODE=api npm run build
```

产物在 `/srv/confession-wall/web/dist/`。改版后重新执行即可（文件名带内容哈希，可长缓存）。

> `VITE_*` 变量会被打进前端产物，**不要放任何密钥**。内测版前端不含任何第三方脚本或 CDN，
> 因此 CSP 只需 `'self'`（见第 4 节）。

---

## 3. 后端依赖与必备环境变量

```bash
cd /srv/confession-wall/server
sudo -u www-data npm ci --omit=dev     # better-sqlite3 会下载预编译二进制
sudo cp .env.example /etc/confession-wall.env
sudo chmod 600 /etc/confession-wall.env
sudo editor /etc/confession-wall.env
```

`server/.env.example` 是**权威清单**（含默认值与取值范围）。下面按「必须改」「按需改」逐条说明。

### 3.1 必须设置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | — | 生产必须 `production`：它同时决定「未配邀请码就拒绝启动」「cookie 带 `Secure`」「`ADMIN_TOKEN` / `IP_HASH_SECRET` 缺失即退出」 |
| `GATE_INVITE_CODES` | 空 | 内测邀请码，逗号或空格分隔可配多个；**每个至少 8 位**，过短的会被忽略并打警告。生产不配置就起不来 |
| `ADMIN_TOKEN` | — | 管理接口令牌，**≥24 字符**（建议 `openssl rand -hex 32`）。缺失或过短时生产环境退出码 1 |
| `IP_HASH_SECRET` | — | 把访客 IP 做不可逆哈希（不落盘原始 IP），**≥16 字符** |
| `WEB_ROOT` | 自动探测 | 生产请显式写 `/srv/confession-wall/web/dist`，避免误判成仓库根 |
| `TRUST_PROXY` | 关 | 反代后置 `1`，否则所有请求都会被当成来自 `127.0.0.1`（限流与门禁会话会互相串台） |
| `FORCE_HTTPS` | 关 | 全站 HTTPS 时置 `1`，输出 HSTS |

### 3.2 内测门禁（`server/src/gate.js`）

| 变量 | 默认 | 取值范围 / 说明 |
| --- | --- | --- |
| `GATE_ENFORCE` | 生产且已配邀请码时自动开启 | `1` 强制 / `0` 关闭（会打警告）；显式配置优先 |
| `GATE_TTL` | `43200`（12 小时） | 60–2592000 秒，通过门禁后签发的会话有效期 |
| `GATE_CHALLENGE_TTL` | `600`（10 分钟） | 30–3600 秒，挑战题有效期 |
| `GATE_CHALLENGE_ITEMS` | `2` | 1–4 题。题多机器成本高，人也会烦 |
| `GATE_MAX_ATTEMPTS` | `5` | 1–20 次，单份挑战允许答错的次数，超过即作废 |
| `GATE_COOKIE` | `od_gate` | 会话 cookie 名 |
| `GATE_COOKIE_SECURE` | 生产默认开 | `1` = 仅 HTTPS。**纯 HTTP 内网部署必须显式设 `0`**，否则浏览器丢弃 cookie，用户会陷入「刚验证完又要求验证」；设置后启动会打警告 |
| `GATE_SECRET` | 复用 `IP_HASH_SECRET` | 会话签名密钥。建议独立生成；**换掉会让所有在线会话立即失效** |
| `GATE_ALLOW_DISABLED` | — | 逃生开关：生产未配邀请码时，显式 `1` 才允许启动（等于承认写接口对全网开放） |

### 3.3 内测标识与反馈（`server/src/beta.js`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BETA_VERSION` | `0.9.0-beta.1` | 下发给前端的版本号（顶栏标识条、页脚、`/api/health`） |
| `BETA_NAME` | `内测版` | 版本标识文案 |
| `BETA_NOTICE` | 内置默认文案 | 首屏公告正文；改文案只需改环境变量后重启，**不必重新构建前端** |
| `BETA_FEEDBACK` | 开 | `0` = 关闭反馈入口（`POST /api/feedback` 直接 403） |
| `FEEDBACK_EMAIL` | 空 | 选填：展示给用户并作为备用反馈渠道 |
| `FEEDBACK_MAX` | `800` | 20–4000，单条反馈正文上限 |
| `FEEDBACK_KEEP` | `2000` | 最小 100；超出后只清理**已处理**的反馈，待处理的永不自动删除 |

### 3.4 数据与性能

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_PATH` | `server/data/wall.db` | SQLite 路径（WAL 模式，同目录生成 `-wal` / `-shm`） |
| `DB_CACHE_MB` | 按内存自动：≤1GB→16，≤2GB→32，否则 64 | 页缓存大小（MB） |
| `DB_CHECKPOINT_MS` | `300000` | WAL 截断间隔（5 分钟） |
| `DB_CLEANUP_MS` | `21600000` | 保留期清理 + `PRAGMA optimize` 间隔（6 小时） |
| `RETENTION_DAYS` | `0` | `0` = 不按时间清理（默认，删数据需运营方明确同意）；`>0` 清理超期的被拒内容、已结案工单、审计日志、已处理反馈 |
| `DB_RECOUNT_ON_BOOT` | `0` | `1` = 启动时强制全量校准点赞计数（仅怀疑漂移时用） |
| `DB_RECOUNT_DAYS` | `7` | 距上次校准超过该天数则校准一次；`0` = 永不 |
| `MAX_BODY` | `32768` | 请求体上限（字节） |
| `PAGE_MAX` | `30` | 单页最大条数（`/api/posts` 的 `limit` 会被钳到这里） |
| `LIKE_FLUSH_MS` | `1500` | 点赞计数批量回写间隔 |
| `FEED_CACHE_MS` | `3000` | 信息流短时缓存；`0` = 关闭。低配 VPS 上收益明显 |
| `BANNED_FILE` | `./data/banned.txt` | 合规词表（每行一个，支持 `#` 注释）；缺省不加载 |
| `BANNED_RELOAD_MS` | `30000` | 词表按 mtime 热重载的检查间隔（毫秒），`0` = 关闭热重载 |
| `ADMIN_RATE_LIMIT` | `10` | 管理鉴权尝试上限（15 分钟窗口，按 IP 哈希）。内部工具批量审核时可调高，不建议关闭 |

### 3.5 生产启动守卫

两道守卫都在启动时立刻生效，**不满足就打印原因并以退出码 1 退出**（而不是裸奔运行）：

1. `NODE_ENV=production` 且未配置 `GATE_INVITE_CODES`，且没有 `GATE_ALLOW_DISABLED=1`；
2. `ADMIN_TOKEN` 或 `IP_HASH_SECRET` 缺失 / 过短。

最小可用配置示例（`/etc/confession-wall.env`）：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8080
WEB_ROOT=/srv/confession-wall/web/dist
INDEX_FILE=index.html
TRUST_PROXY=1
FORCE_HTTPS=1

GATE_INVITE_CODES=<openssl rand -hex 8>       # 至少 8 位；可配多个，逗号分隔
GATE_TTL=43200
GATE_CHALLENGE_TTL=600
GATE_CHALLENGE_ITEMS=2
GATE_MAX_ATTEMPTS=5

ADMIN_TOKEN=<openssl rand -hex 32>
IP_HASH_SECRET=<openssl rand -hex 32>
GATE_SECRET=<再一个 openssl rand -hex 32>     # 可选：独立于 IP_HASH_SECRET 便于单独轮换

DB_PATH=/srv/confession-wall/server/data/wall.db
RETENTION_DAYS=90          # 合规上通常需要明确的保留期限；0 = 不按时间清理
FEED_CACHE_MS=3000
BANNED_FILE=/srv/confession-wall/server/data/banned.txt
```

---

## 4. 反代（Caddy，自动 HTTPS）

```bash
sudo cp /srv/confession-wall/server/deploy/Caddyfile /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile          # 把 wall.example.edu 换成你的域名
sudo systemctl reload caddy
```

Caddyfile 已包含：静态资源直发（省一次 Node 往返）、HSTS / nosniff / Referrer-Policy、访问日志轮转。
`root` 指向 `web/dist`；若仍在用单文件原型，改成 `/srv/confession-wall` 并把 `INDEX_FILE` 换成
`school-confession-wall.html` 即可，两者共用同一套 `/api`。

> **可以在 Caddy 层加 CSP，但不要放宽 `'self'`。** 后端下发的 CSP 是
> `default-src 'self'`、`script-src 'self' 'unsafe-inline'`、`frame-src 'none'`；
> 页面不加载任何第三方脚本或 iframe，若你在 Caddy 再加一层，请保持同样的收紧程度。
> （`'unsafe-inline'` 是给 React 注入的内联样式留的，见 `server/src/server.js` 的注释。）

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
- `TimeoutStopSec=15` + `KillSignal=SIGTERM`：给服务时间刷新点赞计数、`PRAGMA optimize` 并截断 WAL。
  **这一步很重要** —— 被强杀会被记成「非优雅退出」，下次启动会触发全量点赞校准（帖量大时要几秒）。
- `MemoryMax=256M`：超限自动重启，而不是拖垮整机。
- `ProtectSystem=strict` + `ReadWritePaths=/srv/confession-wall/server/data`：只有数据目录可写。
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` 保留 `AF_INET` 只是为了让 DNS 解析与系统校时先就绪，
  **不是因为服务需要出网**。

验证：`curl -s http://127.0.0.1:8080/api/health` 应返回 `{"ok":true,...,"version":"0.9.0-beta.1","tag":"内测版"}`。

### 不需要任何出网请求

| | 旧版（v2.1.0，Turnstile + 短信） | 内测版 `0.9.0-beta.1` |
| --- | --- | --- |
| 人机验证 | 必须能访问 `challenges.cloudflare.com`（失败还要处理 fail-open/fail-closed） | **本进程内完成**，无出网 |
| 实名 / 短信 | 必须能访问短信通道网关 | **已移除**（不收集手机号） |
| 前端第三方资源 | 需要放行 Cloudflare 的 `script-src` / `frame-src` | **零第三方资源**，CSP 只需 `'self'` |
| 出网需求 | 至少两条外呼链路 | **0 条** |

因此你可以把出网规则收紧到「只允许 DNS / NTP（可选）」，甚至放在完全没有外网出口的内网里跑。
唯一的代价是：本机要能解析自己的域名（若前端与 API 同源，这一点也不需要）。

---

## 5.5 面板部署（Pterodactyl / Wispbyte 等，没有 shell）

游戏面板类主机（Wispbyte、Pterodactyl、Pelican 等）的 Node.js 蛋是这样启动的：

```bash
git pull                          # AUTO_UPDATE=1 时
npm install                       # 只会跑仓库根目录这一条
node /home/container/${JS_FILE}   # 启动命令固定，用户改不了，也开不了 shell
```

三条硬约束决定了怎么配：

| 约束 | 应对 |
| --- | --- |
| 启动命令固定为 `node ${JS_FILE}`，**没法 `npm --prefix server install`** | 仓库根的 `prepare` 钩子（`scripts/prepare.mjs`）会在 `npm install` 之后自动装好 `server/node_modules`（better-sqlite3）**并构建前端** → `web/dist` |
| **没法用 `--env-file`，也不好逐个注入环境变量** | `server/src/env.js` 会自动读 `server/.env`（零依赖，已存在的环境变量优先）。面板的文件管理器上传/编辑这个文件即可 |
| 面板分配的端口是动态的 | `PORT`/`HOST` 缺省时会读面板注入的 `SERVER_PORT` / `SERVER_IP`，无需手写 |

### 面板里要填/要放的

| 位置 | 值 |
| --- | --- |
| Startup → **JS_FILE** | `server/src/server.js` ← **不要填 `index.html`**（会报 `ERR_UNKNOWN_FILE_EXTENSION ".html"`） |
| Startup → **AUTO_UPDATE** | `1`（每次启动 `git pull`；不要的话就得自己拉代码） |
| Startup → **NODE_PACKAGES** | 留空（后端依赖由 `prepare` 负责） |
| Docker Image | **`ghcr.io/parkervcp/yolks:nodejs_22`**（Node 18/20/22 都行；**别用 nodejs_19** —— 它是非 LTS，vite 与 better-sqlite3 的预编译包都不覆盖它） |
| 文件管理器 | 新建 `server/.env`，内容见下（面板文件树里的路径是 `/home/container/server/.env`） |

`server/.env`（纯 HTTP、面板直连的最简一份）：

```ini
NODE_ENV=production
# 面板会注入 SERVER_PORT / SERVER_IP，通常无需写 PORT/HOST；
# 若面板没注入（或你想写死），PORT 只能填**数字**，例如 PORT=25565。
# 不要写 PORT=$SERVER_PORT / PORT=<端口> 这类「看起来像变量」的值 —— 服务端会把
# 非法端口忽略并告警（不会崩），然后回退到 SERVER_PORT / 8080。
# PORT=25565
# HOST=0.0.0.0

WEB_ROOT=/home/container/web/dist
INDEX_FILE=index.html
TRUST_PROXY=0
FORCE_HTTPS=0

GATE_INVITE_CODES=<openssl rand -hex 8 生成的随机串>
GATE_COOKIE_SECURE=0        # 面板给的是 http://IP:端口，不设 0 浏览器会丢弃会话 cookie

ADMIN_TOKEN=<openssl rand -hex 32>
IP_HASH_SECRET=<openssl rand -hex 16>
GATE_SECRET=<openssl rand -hex 16>
```

启动成功的日志长这样（面板 Console 里能看到）：

```
[prepare] 安装后端依赖 → server/node_modules
[prepare] 前端已构建 → web/dist
[env] 已从 /home/container/server/.env 读取 12 项配置
[up] 表白墙服务（内测版 0.9.0-beta.1）http://0.0.0.0:25565
[up] 内测门禁 开启（邀请码 已配置）
```

### 面板部署的排查顺序

1. `ERR_UNKNOWN_FILE_EXTENSION ".html"` → `JS_FILE` 填错了，应为 `server/src/server.js`。
2. **`Could not locate the bindings file` / `npm warn install-scripts … better-sqlite3 (install: node-gyp rebuild)`**
   → **npm 12 起默认不执行依赖的安装脚本**（供应链加固），而 better-sqlite3 的原生二进制正是靠安装脚本
   （`prebuild-install` 下载预编译包）就位的。
   仓库已经处理：`.npmrc` 与 `server/.npmrc` 显式放行了 `better-sqlite3` / `esbuild`；
   即使你的 npm 不认这项配置，`scripts/prepare.mjs` 也会在安装后检查
   `server/node_modules/better-sqlite3/build/Release/better_sqlite3.node`，缺失时自己补跑
   `prebuild-install`（秒级），再不行才回退 `node-gyp rebuild`（需要 python3 / make / g++）。
   日志里会看到 `[prepare] better-sqlite3 缺原生二进制…正在补装`。
   若两种方式都失败（容器缺编译器且不能访问 GitHub Releases）：把本机 `server/node_modules` 打包上传解压，
   或请面板管理员放行安装脚本。
3. `Cannot find module 'better-sqlite3'` → 依赖根本没装上：确认镜像是 **nodejs_22 / nodejs_20**（别用 19），
   并确认 `npm install` 没被加 `--omit=dev`。
4. 页面 404 或样式全无 → 日志出现 `[warn] 前端产物不存在`：vite 没构建成功（Node 19 上较常见）→ 换 nodejs_22；
   或本机 `npm run build` 后把 `web/dist` 上传。
5. 一直反复要求验证邀请码 → `GATE_COOKIE_SECURE` 没设成 `0`（面板是 http）。
6. `EADDRINUSE` 或面板显示端口不通 → 面板注入的端口没被读到，在 `server/.env` 里显式写
   `PORT=<面板分配的端口>`、`HOST=0.0.0.0`。
7. 面板自动重启且日志出现 `Assertion failed: (env) != nullptr`（退出码 134）→ 已知的 better-sqlite3 原生 teardown 竞态，
   只在**带管道 stdout 的子进程正常退出**时出现；服务进程本身不受影响（服务是被 kill 的）。若真遇到，把 Node 换成 22 LTS 再试。

> 面板主机多数不带 TLS 也不能自定义域名：内测够用，但**会话 cookie 与邀请码都是明文传输**，
> 同一网络里的人可以抓走。要对外长期用，还是换回 §4/§5 的 Caddy + systemd 那套。

---

## 6. 上线验收清单

```bash
cd /srv/confession-wall
WALL=https://wall.example.edu

# 1) 首页能开，且是 React 版（不是单文件原型）
curl -s $WALL/ | grep -c 'id="root"'

# 2) 门禁配置已下发（公开接口，不含任何机密）
curl -s $WALL/api/gate/config
#   期望：required:true、inviteRequired:true，beta.version=0.9.0-beta.1

# 3) 绕过前端直接发帖，必须被拦（最关键的一条）
curl -s -o /dev/null -w '%{http_code}\n' -X POST $WALL/api/posts \
  -H 'content-type: application/json' \
  -d '{"cat":"表白","body":"这条不该被写进去，应该被 403 拦下"}'
#   期望 403，且 body 是 {"error":"gate_required",...}
curl -s -X POST $WALL/api/posts -H 'content-type: application/json' \
  -d '{"cat":"表白","body":"再确认一次错误码"}' | grep -o 'gate_required'

# 4) 管理接口未鉴权应 401（连续打会变成 429，这是限流在起作用）
curl -s -o /dev/null -w '%{http_code}\n' $WALL/api/admin/stats

# 5) 后台页面由后端直接提供（反代层请另行限制来源！）
curl -s -o /dev/null -w '%{http_code}\n' $WALL/admin

# 6) 安全头
curl -sI $WALL/ | grep -i -E 'content-security-policy|strict-transport|x-content-type|frame-options'
#   期望 CSP 里只有 'self'，且 frame-src 'none'、frame-ancestors 'none'

# 7) 压缩与缓存（详见第 8 节）
curl -sI -H 'Accept-Encoding: br' $WALL/assets/$(ls web/dist/assets | grep '\.js$' | head -1) \
  | grep -i -E 'content-encoding|cache-control'

# 8) 内测版不被搜索引擎收录
curl -s $WALL/ | grep -o 'name="robots" content="noindex, nofollow"'

# 9) 数据库里不应残留实名时代的表（升级自旧库时确认一次）
sqlite3 /srv/confession-wall/server/data/wall.db \
  "SELECT name FROM sqlite_master WHERE name IN ('identities','identity_codes');"
#   期望：无输出（表已被幂等迁移删除；若列删不掉，代码也不再读写）

# 10) 客户端不该发出任何第三方请求
#    浏览器 DevTools → Network，刷新首页：所有请求都应指向你自己的域名
```

浏览器里再走一遍完整链路：

1. 首屏出现**内测标识条**与**内测公告**（公告可关闭，关闭状态记在 localStorage，换版本号会重新出现）
2. 点「发布告白」→ 填内容提交 → 弹出**内测验证**弹层（邀请码 + 本地题目）
3. 填邀请码、答对题目 → 提交后提示「已提交，等待审核通过后公开」
4. 打开 `/admin` → 用 `ADMIN_TOKEN` 登录 → 在「待审队列」里看到这条 → 点「通过」
5. 回到首页刷新 → 内容出现在墙上；同一浏览器内后续写操作不再要求答题（默认 12 小时）
6. 在页脚点「内测反馈」提交一条 → 后台「内测反馈」工作区能看到 → 处理后归档

### 审核后台的访问控制（重要）

`/admin` 是**单文件后台**，由后端直接提供（`server/public/admin.html`）。它自身用 `ADMIN_TOKEN`
调管理接口（令牌只存在浏览器 localStorage），所以页面本身不设登录墙 —— 但**你必须限制它的来源**，
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

---

## 7. 数据库维护（低配 VPS）

数据库是单文件 `server/data/wall.db`（WAL 模式，同目录会有 `-wal` / `-shm`）。

**日常自动做的事**（无需干预）：每 5 分钟 WAL 截断、每 6 小时清孤儿行并刷新统计信息、
退出时标记干净退出 + `PRAGMA optimize` + WAL 截断。

**周期性体检**：

```bash
cd /srv/confession-wall/server
npm run db:check      # 只读体检：体积、页数、可回收空间、各表行数（含 feedback）
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

**词表热重载**：改完 `data/banned.txt` 不用重启，默认 30 秒内生效（`BANNED_RELOAD_MS` 可调）。

---

## 8. 压缩与缓存：怎么验证

内测版把响应压缩升级为 **br 优先 + gzip 兜底**（质量档自适应：静态产物 `q11`/`q9`、动态 JSON `q5`），
并按 ETag 缓存压缩结果（静态产物只压一次），静态产物分三档缓存。验证命令如下（`HEAD` 请求即可看到头）：

```bash
# ① 带内容哈希的 JS/CSS：期望 content-encoding: br + 一年 immutable
ASSET=$(ls /srv/confession-wall/web/dist/assets | grep '\.js$' | head -1)
curl -sI -H 'Accept-Encoding: br' http://127.0.0.1:8080/assets/$ASSET \
  | grep -i -E 'content-encoding|cache-control|vary|etag'
#   content-encoding: br
#   cache-control: public, max-age=31536000, immutable
#   vary: Accept-Encoding

# ② 只接受 gzip 的客户端：走 gzip 兜底
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:8080/assets/$ASSET | grep -i content-encoding
#   content-encoding: gzip

# ③ HTML：期望 no-cache + ETag（改版立即生效，重复请求回 304）
curl -sI http://127.0.0.1:8080/ | grep -i -E 'cache-control|etag'
curl -sI -H 'If-None-Match: <上面的 etag>' http://127.0.0.1:8080/ | head -1
#   HTTP/1.1 304 Not Modified

# ④ 公开列表接口：private, no-cache + ETag，条件请求回 304
curl -sI http://127.0.0.1:8080/api/posts | grep -i -E 'cache-control|etag|content-encoding'

# ⑤ 信息流短时缓存命中标记（并发首屏会被合并成一次查询）
curl -s -D - -o /dev/null 'http://127.0.0.1:8080/api/posts?limit=20' | grep -i 'x-cache'
```

三个容易误判的点：

1. **`content-encoding` 只在响应体 ≥1KB 且客户端发了 `Accept-Encoding` 时才有**；
   小文件不压是刻意的（压缩后可能更大）。
2. **经过 Caddy 时看到的编码可能不是后端的。** `deploy/Caddyfile` 里配了 `encode zstd gzip`，
   Caddy 会自行压缩；要确认后端行为，请像上面一样直连 `127.0.0.1:8080`。
3. **`vary: Accept-Encoding` 必须存在**，否则中间的共享缓存可能把 br 响应发给只支持 gzip 的客户端。

---

## 9. 备份、回滚与观察

### 备份

```bash
# 推荐 .backup（比直接拷文件安全；拷文件前先 checkpoint）
sudo -u www-data sqlite3 data/wall.db ".backup '/var/backups/wall-$(date +%F).db'"
# 只保留最近 14 天
find /var/backups -name 'wall-*.db' -mtime +14 -delete
```

放进 crontab 每天凌晨执行，并把备份同步到另一台机器 / 对象存储。
**备份里含哈希后的 IP、UA 哈希与全部内容**，按个人资料同等级别保护。

### 回滚

```bash
# 后端：回到上一个可用 commit（数据库结构变更都是幂等的，向前兼容）
cd /srv/confession-wall && git checkout <上一个可用 commit>
sudo systemctl restart confession-wall

# 前端可独立回滚：重新构建上一个 commit 的产物即可（API 未变）
VITE_DATA_MODE=api npm run build

# 前端回滚实例（发版出问题时最常用）
git checkout <上一个可用 commit> -- web/ index.html && VITE_DATA_MODE=api npm run build
```

> **注意版本号方向**：内测版号 `0.9.0-beta.1` **低于** v2.1.0 —— 这是刻意的
> （内测阶段回到 0.x，明确不承诺 API/数据稳定）。因此**不要用版本号大小判断新旧**，
> 一律以 commit / tag 为准。升级到内测版后，`identities` / `identity_codes` 会被删除且不可逆，
> 回滚到 v2.1.0 之前请先备份数据库。

### 上线后建议观察一周

| 指标 | 从哪看 | 关注点 |
| --- | --- | --- |
| **待审队列长度 / 最久等待** | `/api/admin/stats` 的 `pendingTotal` / `oldestPendingAt` | 持续增长说明没人审，或规则误伤太多 —— 这是「先审后发」能不能守住的关键 |
| **未处理反馈** | 同上 `openFeedback` | 内测期最重要的输入，别让它积压 |
| **门禁状态** | 同上 `gateRequired` / `gateInviteRequired` | 必须都是 `true`；出现 `false` 说明写接口在裸奔 |
| **被拦下的写请求** | `journalctl`（`403`）+ 用户反馈 | 大量 `challenge_expired` 说明会话太短或用户中途换网络 |
| **数据库体积 / WAL** | `db.fileBytes` / `db.walBytes` | WAL 持续 > 20MB 说明 checkpoint 未生效 |
| **内存占用** | `systemctl status` | 接近 `MemoryMax=256M` 就需要上 swap 或降 `DB_CACHE_MB` |
| **举报工单** | `/api/admin/reports?status=open` | 通知—移除机制要求尽快核查 |

低配机器的两条保险：**加 1GB swap**（防 Node 尖峰 OOM）、
**把静态资源交给 CDN 缓存**（源站只处理动态请求）。

---

## 10. 常见故障排查

### ① 生产环境起不来：未配置邀请码（最常见）

`journalctl -u confession-wall -n 20` 会看到（stderr 原文，退出码 1）：

```
[fatal] 未配置 GATE_INVITE_CODES，内测门禁关闭 ——
  生产环境默认拒绝以此状态启动（任何人都能直接调写接口）。
  修复：设置 GATE_INVITE_CODES=<至少 8 位的邀请码，逗号分隔可配多个>；
        或显式设置 GATE_ALLOW_DISABLED=1 明确承担风险。
```

解法（二选一）：

```bash
sudo editor /etc/confession-wall.env
# 方案 A（推荐）：GATE_INVITE_CODES=$(openssl rand -hex 8)
# 方案 B（不推荐，仅在明确知道后果时）：GATE_ALLOW_DISABLED=1
sudo systemctl restart confession-wall
```

### ② 起不来：令牌缺失或过短

```
[fatal] ADMIN_TOKEN 未设置或过短（至少 24 字符）
[fatal] IP_HASH_SECRET 未设置或过短（至少 16 字符）
```

`ADMIN_TOKEN` 与 `IP_HASH_SECRET` 在 `NODE_ENV=production` 下是硬性要求；
开发环境会用随机临时值代替并打 `[warn]`（重启即失效）。

### ③ 启动日志说邀请码被忽略

```
[gate] 忽略过短的邀请码（至少 8 位）：ab…
```

邀请码每个都要 ≥8 位，否则被丢弃。若全部过短，等价于「没配邀请码」→ 见 ①。

### ④ 用户过不了门禁

| 现象（前端 / 接口） | 服务端错误码 | 原因与处理 |
| --- | --- | --- |
| 「内测邀请码不正确」 | `403 invalid_code` | 码错、或码里有全角字符 / 多余空格；确认发的是当前 `GATE_INVITE_CODES` |
| 「验证已过期，请重新获取题目」 | `409 challenge_expired` | 题目超过 `GATE_CHALLENGE_TTL`（默认 10 分钟）；点「换一道题」 |
| 「网络环境已变化，请重新获取题目」 | `409 challenge_expired` | 挑战绑定了 IP 哈希，用户中途切换网络（4G↔WiFi）；重新取题即可 |
| 「答案不正确，还可以试 N 次」 | `403 challenge_failed` | 答错；超过 `GATE_MAX_ATTEMPTS` 后整份挑战作废 |
| 「尝试过于频繁，请稍后再试」 | `429 rate_limited` | `/api/gate/verify` 限流 20 次/10 分钟、`/api/gate/challenge` 30 次/10 分钟（按 IP 哈希） |
| 已验证却仍被拦 | `403 gate_required` | 会话过期（`GATE_TTL`）、换了 `GATE_SECRET`、或**反代没开 `TRUST_PROXY=1`** 导致 IP 哈希与签发时不一致 |

> **`TRUST_PROXY` 是最容易踩的一个坑**：反代后不设 `1`，所有访客会被算成同一个 IP 哈希，
> 于是「一个人通过门禁 = 所有人通过」，限流也会互相挤掉。生产必须置 `1`。

### ⑤ 后台相关

| 现象 | 原因 / 处理 |
| --- | --- |
| 后台一直显示「演示模式」 | 前端连不上 `/api`（反代没转发、`/admin` 是从别的静态服务打开的）。演示模式下所有操作只在本页生效 |
| `401 unauthorized` | `ADMIN_TOKEN` 与 `.env` 不一致（注意令牌两端空格） |
| `429 rate_limited` | 管理鉴权限流：默认 10 次 / 15 分钟（`ADMIN_RATE_LIMIT`）。批量审核工具可调高 |
| 点「通过」没反应 | 打开浏览器控制台看请求；若是 404，确认内容 id 仍存在（可能已被清理或下架） |

### ⑥ 静态资源 / 页面

| 现象 | 原因 / 处理 |
| --- | --- |
| 首页 404 | `WEB_ROOT` 指错（生产要指向 `web/dist`），或忘了 `npm run build` |
| `/admin` 404 | 后端没起来，或反代把 `/admin` 当成静态路径交给了 Caddy 的 `file_server` |
| 资源缓存不更新 | 带哈希的产物用「一年 immutable」是设计如此；HTML 是 `no-cache`，刷新即可拿到新版本号 |
| 压缩没生效 | 响应体 <1KB、客户端没发 `Accept-Encoding`，或 Caddy 抢先按自己的 `encode` 压了（见第 8 节） |

### ⑦ 数据库

| 现象 | 处理 |
| --- | --- |
| `database is locked` | 有长事务或外部 `sqlite3` 会话占着写锁；`busy_timeout` 是 5 秒。检查是否有常驻只读连接 |
| 磁盘涨得快 | `npm run db:check` 看 `reclaimableBytes` / `walBytes`；必要时 VACUUM（第 7 节） |
| 评论数不对 | `npm run db:recount` 只校准点赞；评论数由审核动作维护（通过 +1、驳回已通过的 −1），若怀疑异常请核对 `comments.status` 与 `comment_count` |

### ⑧ 已知问题：Windows 上的原生断言（不影响 Linux 生产）

在 Windows 开发机上，**带活跃 better-sqlite3 连接调用 `process.exit()`** 会偶发触发 Node 的原生断言
（`RemoveEnvironmentCleanupHook` / `Statement` 析构），进程以 SIGABRT(134) 结束。表现是
「服务偶发崩溃」，且发生在启动/收尾附近而不是请求处理中。已做的规避（都在代码里）：

- 优雅停机改为**设置 `process.exitCode` 后自然退出**，不再强制 `process.exit()`
- 致命错误路径先同步写日志 → 关库 → 再退出
- 提供 `POST /api/admin/shutdown` 作为不依赖信号的收尾入口
  （Windows 的 `child.kill("SIGTERM")` 不会触发 JS 信号处理器）
- 排障用：`DEBUG_EXIT=1` 会在退出时把 `process.exit` 的调用栈写到 stderr

**Linux + systemd 不受影响**：信号处理器正常工作，收尾会写入干净退出标记、执行 `PRAGMA optimize`
并截断 WAL。若在 Windows 上看到这个崩溃，重启即可，它不会损坏数据库（WAL 保证写入原子性）。

---

## 11. 常用运维命令

```bash
systemctl restart confession-wall          # 重启（会优雅收尾）
journalctl -u confession-wall -f           # 实时日志
curl -s localhost:8080/api/health          # 健康检查（含版本与内测标识）

# 队列、体积与内测运营指标
curl -s localhost:8080/api/admin/stats -H "Authorization: Bearer $TOKEN"

# 审核：推荐直接用后台界面（需 SSH 隧道或反代放行）
#   ssh -L 8080:127.0.0.1:8080 user@your-vps  →  本机打开 http://127.0.0.1:8080/admin
# 也可以用 API（便于脚本化批量审核）：
curl -s 'localhost:8080/api/admin/queue?type=posts&limit=50' -H "Authorization: Bearer $TOKEN"
curl -s 'localhost:8080/api/admin/queue?type=comments&q=关键词' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/api/admin/posts/12/approve -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/api/admin/bulk -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"type":"posts","ids":[12,13],"action":"approve"}'
curl -s 'localhost:8080/api/admin/audit?limit=50' -H "Authorization: Bearer $TOKEN"

# 内测反馈队列
curl -s 'localhost:8080/api/admin/feedback?status=open' -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8080/api/admin/feedback/3/resolve -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"action":"done"}'

# 受控优雅停机（不依赖信号，Windows 上也能用；会写干净退出标记并截断 WAL）
curl -s -X POST localhost:8080/api/admin/shutdown -H "Authorization: Bearer $TOKEN"
```

排障用的后端自检（不影响在跑的服务）：

```bash
cd /srv/confession-wall/server
npm run db:check      # 真实库只读体检
npm test              # 接口 + 门禁 + 数据库自检（临时库、临时端口）
```

---

## 12. 合规收尾（香港）

> 以下为工程实践提示，**不是法律意见**。请由具备香港执业资格的律师审阅后再上线。

- **内测版的数据面比 v2.1.0 小得多**：不再收集手机号，也没有账号体系。落库的个人资料只有
  内容本身 + `HMAC-SHA256(IP)` 前 24 位（`ip_hash`）+ UA 哈希（`ua_hash`）+ 反馈里用户自愿填写的联系方式。
- **「匿名不等于无资料」仍然要写进隐私政策**：前台不展示身份，但平台仍处理个人资料
  （哈希后的 IP / UA、内容、工单与留痕），需说明收集目的（反滥用、举报核查、安全审计）、
  保留期限与查阅/更正渠道。
- **保留期限**：建议 `RETENTION_DAYS=90`，并说明它会清理被拒内容、已结案工单、审计日志与已处理反馈；
  **未处理的反馈永不自动删除**。
- **起底（doxxing）刑事化**：联系方式与可识别个人资料的规则已在 `server/src/moderation.js` 里覆盖，
  命中即转人工；但真正的兜底是**先审后发要有人真的每天看队列**。
- **通知—移除**：《诽谤条例》下收到有效通知后应尽快下架，`reports` 表就是这套工单。
- **未成年人**：涉及未成年人的内容优先级更高，建议在发布公约中加入监护人同意条款。
- **数据出境**：哈希后的 IP、内容与反馈都留在本机 SQLite；若你把备份同步到境外对象存储，
  需要按 PDPO 评估跨境转移要求。
- **上线前替换**：`report@example.edu`、示例校名、模板版本日期；`data/banned.txt` 换成经审阅的词库。
- **邀请码即边界**：它是内测站点的唯一准入凭据，发放要有名单意识，泄露后立即轮换
  （`GATE_INVITE_CODES` 改完重启即可，已在线的会话不受影响；要立刻踢掉所有人则同时更换 `GATE_SECRET`）。
