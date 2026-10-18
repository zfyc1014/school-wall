# 安全审计与加固记录

> 审计对象：校园墙 v1.0.1（单进程 Node + SQLite + React SPA）。
> 所有修复都配了可复现的回归测试（`server/scripts/security-test.js`，**59 项**），
> 已接入 `npm test` / `npm run verify`。

## 一、发现与修复

| # | 级别 | 问题 | 影响 | 修复 |
| --- | --- | --- | --- | --- |
| V1 | **高** | `TRUST_PROXY=1` 时**无条件**采信 `X-Forwarded-For`，且取最左一项（客户端可伪造） | 站点可被直连时，攻击者每个请求换一个 XFF 即可绕过**全部按 IP 的限流**：验证码轰炸、后台令牌爆破、举报刷单；还能伪造后台「IP 来源」统计 | 新增 `server/src/net.js`：只在对端属于**可信代理**（默认回环/私有网段，可用 `TRUST_PROXY_IPS` 扩展）时才看转发头；改取 XFF **最右一跳**；IP 统一规范化（IPv4-mapped、带端口、zone id）；`TRUST_PROXY=any` 才允许无条件信任 |
| V2 | **高** | `WEB_ROOT` 允许回退到仓库根，静态服务只校验「在 WEB_ROOT 内」 | 前端产物缺失/配置错误时，`/server/.env`、`/server/data/wall.db`、`/.git/config` 可被直接下载（密钥、用户数据、历史） | 静态资源改为严格白名单：禁止点开头的路径段、禁止 `server/scripts/docs/data/web/node_modules` 目录、扩展名必须在 MIME 表内、`realpath` 必须仍在 WEB_ROOT 内（防符号链接逃逸） |
| V3 | **中** | CSP 的 `script-src` 含 `'unsafe-inline'` | 一旦出现 XSS 注入点，注入的 `<script>` 会被执行，CSP 形同虚设 | 启动时从 `index.html` 提取内联脚本的 sha256 加入 CSP（SPA 不再允许 inline）；`/houtai/` 是单文件控制台，单独下发允许 inline 的 CSP；顺带补 `object-src 'none'` |
| V4 | **中** | 限流桶无上限，键里含用户可控输入（邮箱/号码） | 配合 V1 可构造海量唯一键把内存撑爆（DoS） | `rate-limit.js` 加硬上限（默认 5 万，可用 `RATE_LIMIT_MAX_KEYS` 调）+ 过期优先淘汰 |
| V5 | **中** | 畸形百分号编码（`/%`）与畸形 Cookie 会让 `decodeURIComponent` 抛错 | 变成 500 错误、可被用来刷错误日志 | 路径、路由参数、会话 Cookie 全部改为安全解码（坏输入 → 400 或按原值处理） |
| V6 | **低** | 超大请求体直接 `req.destroy()` | 客户端看到的是连接重置而不是 413，且留下半截连接 | 超限后继续「读掉不累积」，正常返回 413；超过 8 倍上限才断连 |
| V7 | **低** | 缺少 `Cross-Origin-Resource-Policy`、未关闭遗留 XSS 过滤器 | 资源可被他站引用；旧过滤器可能被利用裁切页面 | 补 `CORP: same-origin`、`X-XSS-Protection: 0` |

## 二、SQL 注入专项结论：**未发现可注入点**

逐条核对过全部 SQL 构造路径：

1. **所有值一律使用绑定参数**（`?` / `@name`），不存在把用户输入拼进 SQL 文本的代码；
2. **动态 SQL 片段全部来自常量白名单**：
   - 更新类（用户/学校/头衔/公告）：`sets` 里是硬编码的 `"col = ?"`；
   - 列表类（信息流/论坛/队列/后台用户/工单/审计/赞助）：`where` 数组里只有常量片段，
     `cat` / `sort` / `board` / `status` / `type` 等参数先过白名单再作为**绑定值**；
   - 游标与分页参数一律 `toInt()` / `Number()` 数值化；
   - `IN (...)` 的占位符由数组长度生成，值单独绑定；
3. **LIKE 查询做了转义**（`escapeLike` + `ESCAPE '\\'`），`%`/`_` 通配符无法被利用；
4. **迁移里的** ``${table}` / `${column}` 全部是代码内常量，不接受外部输入；
5. 回归测试对 7 组典型载荷（`' OR '1'='1`、`'; DROP TABLE posts; --`、`UNION SELECT` 等）
   × 6 个接口做了注入尝试，并断言注入后**数据表仍然存在**、正常搜索仍然工作。

## 三、已覆盖的攻击面（回归测试）

- 路径穿越：原始 / 编码 / 双编码 / 反斜杠 / 空字节变体，敏感文件不可下载
- SQL 注入：信息流搜索、分类、路径参数、游标、后台用户/队列/工单/审计、论坛板块
- XSS：Markdown 渲染器（`<script>`、`javascript:` 链接、外链图片、行内代码、属性注入）、首页 Markdown 存储与渲染
- 鉴权：未授权管理接口、错误令牌、**CSRF**（管理接口只认 Bearer，不吃会话 Cookie）、私信 IDOR
- 代理头伪造：三种部署形态（不信任 / 可信反代 / 可直连但配了信任列表）
- 协议健壮性：畸形编码、畸形 Cookie、超大请求体、非法 JSON、静态资源非 GET
- 响应头与 Cookie：CSP（含内联脚本哈希）、nosniff、frame deny、CORP、HttpOnly/SameSite/Secure
- 资源耗尽：限流器海量唯一键不增长

## 四、残余风险与部署建议

1. **TRUST_PROXY 要配对**：反代与源站之间请只允许反代访问（防火墙限定 Cloudflare/反代 IP 段），
   否则直连流量可以伪造转发头。若确实只能直连，保持 `TRUST_PROXY` 为空。
2. **Cloudflare 边缘**：建议开 Bot Fight Mode + 写请求 Managed Challenge（见 DEPLOY.md ⑪），
   应用内的 `BOT_GUARD` 只是 UA 启发式，可被绕过，属于「提高成本」而非「防线」。
3. **密钥轮换**：`ADMIN_TOKEN`、`IP_HASH_SECRET` 应定期轮换；任何曾出现在聊天/截图/仓库历史里的值都要视为已泄露。
4. **后台入口**：`/houtai/` 本身是静态页（数据全靠令牌），建议在反代层再加一层来源限制或 HTTP Basic。
5. **依赖**：`npm audit` 报告的 3 项均来自开发依赖链（vite/esbuild 相关），生产运行时不加载；能升就升。
6. **原始 IP 不落库**：这是隐私设计，也意味着无法做基于原始 IP 的取证；需要时请走反代日志。

## 五、报告安全问题

请发邮件到 `huan_zhe@outlook.com`，说明复现步骤与影响面；确认后会在修复版本中致谢（如希望匿名请注明）。
