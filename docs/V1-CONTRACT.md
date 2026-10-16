# 校园墙 v1.0.0 · 实现契约（唯一事实来源）

> 本文件是 v1.0.0 重构的**接口契约**。所有并行的实现都必须严格按本文件写，
> 不得自行更改字段名、函数名、CSS 类名前缀或文件归属。契约改动必须回到本文件先改。

## 1. 产品定位与本次范围

校园表白墙 v1.0.0：正式版。删除全部内测（beta）与示例内容，版本号统一为 `1.0.0`。

本次交付：

1. **界面重构**：移动优先、主界面极简、底部液态玻璃 dock、新增论坛（显示昵称、可讨论）。
2. **用户系统**：邮箱验证码登录（Cloudflare Email Service 发送）+ UUID 作为对外标识；
   昵称本地预审（违禁词库）；后台可见用户全部信息；账号个性化；好友 + 私信；
   头衔（后台自定义）+ 等级（显示在头衔之后，空间紧张时可省略）。
3. **首页公告栏**：后台可增删改。
4. **杂项**：取消表白字数上限；登录时强制选学校，学校显示在用户主页且**位于头衔之前**，选定不可更改。

## 2. 文件所有权（写作用域，禁止越界）

| 所有者 | 文件 |
| --- | --- |
| LEAD | `server/**`（除 `server/public/admin.html`、`server/data/banned.txt`、`server/data/schools.txt`）、`web/src/{main.jsx,App.jsx,router.jsx}`、`web/src/api/**`、`web/src/context/**`、`web/src/components/**`、`web/src/styles/{tokens,global,app,wall,sheets,mobile}.css`、`web/src/lib/**`、`index.html`、根 `package.json`、`scripts/**`、`README.md` 等文档 |
| FORUM | `web/src/forum/**`、`web/src/styles/forum.css` |
| SOCIAL | `web/src/social/**`、`web/src/styles/social.css` |
| ME | `web/src/me/**`、`web/src/styles/me.css` |
| ADMIN | `server/public/admin.html` |
| DATA | `server/data/banned.txt` |

> 学校名单**不再生成文件**：改为数据库表 `schools`，由后台（`/houtai/` 的「学校管理」）维护。

**共用文件只能由 LEAD 改。** 各 feature 只允许新建/修改自己那一列的文件。

## 3. 设计语言（移动优先 + 液态玻璃）

- 内容列：手机全宽；桌面居中，最大 `--content-max: 640px`（论坛/私信同宽）。
- 底部 dock 悬浮在内容之上，内容底部预留 `--dock-safe` 高度，滚动时内容从玻璃下穿过。
- 主界面**只保留**：公告栏（可折叠一行）、分类 chips、信息流、dock。不要 hero、CTA、页脚长文、数据源说明。
- 文案原则：一句话说清，不写自我说明；不出现「内测」「演示」「示例」字样。
- 触摸目标 ≥ 44px；输入框字号 ≥ 16px（避免 iOS 缩放）；安全区 `env(safe-area-inset-*)` 必须处理。
- 支持深色模式：只允许通过 `tokens.css` 的变量切换，feature 样式里**不许出现颜色字面量**。

### 液态玻璃（LEAD 提供，可直接用）

```css
.glass        /* 标准液态玻璃：backdrop-filter: blur + saturate，内高光 + 细边 */
.glass-strong /* 更实的玻璃：弹层头部/对话框 */
.glass-dock   /* dock 专用：更厚的高光与投影 */
```

禁止自己写 `backdrop-filter`；需要新变体时用 `.glass` + 自己的类做微调。

### 通用类（LEAD 提供，直接用，不要重名）

```
布局   .app .page .page-head .page-title .section .stack .row .spread .container
卡片   .card .card-pad .list .list-item
按钮   .btn .btn-primary .btn-ghost .btn-secondary .btn-sm .btn-block .btn-icon .fab
表单   .field .field-label .input .textarea .select .counter
展示   .chip .chips .avatar .avatar-sm .avatar-lg .badge .badge-title .badge-level
       .tag .muted .meta .empty .skeleton .divider
弹层   .sheet .sheet-backdrop .sheet-panel .sheet-head .sheet-body .sheet-foot .sheet-grab
提示   .toast（已有）
状态   .is-active .is-disabled .is-loading
```

Feature 前缀：论坛 `.forum-*`、社交 `.social-*`、账号 `.me-*` / `.auth-*`。

## 4. 路由（hash 路由，LEAD 提供）

```js
import { useRoute, navigate, Link } from '../router.jsx';
const { path, params, query } = useRoute(); // path: '/forum/12' 形式，不含 '#'
navigate('/forum/12');                     // 入栈
navigate('/login', { replace: true });
```

| 路由 | 页面 | 所有者 |
| --- | --- | --- |
| `/` | 表白墙首页 | LEAD |
| `/forum` | 论坛列表 | FORUM |
| `/forum/:id` | 帖子详情 + 回复 | FORUM |
| `/forum/new` | 发帖（整页，非弹层） | FORUM |
| `/messages` | 会话列表 | SOCIAL |
| `/messages/:uuid` | 与某人的聊天 | SOCIAL |
| `/friends` | 好友 + 新的朋友 | SOCIAL |
| `/me` | 我的主页 | ME |
| `/u/:uuid` | 他人主页 | ME |
| `/settings` | 账号个性化设置 | ME |
| `/login` | 登录（邮箱验证码 + 首次选学校/昵称） | ME |

## 5. 前端 API 客户端（LEAD 提供 `web/src/api/client.js`）

```js
import { api, ApiError } from '../api/client.js';

// 站点
await api.site()                                  // → {version, siteName, announcements, emailConfigured, features}
await api.schools()                               // → {items: string[]}

// 账号
await api.auth.requestCode(email)                 // → {ok:true, expiresIn, devCode?}
await api.auth.verify(email, code)                // → {user} | {needProfile:true, token, email}
await api.auth.register({token, nickname, school, avatar})  // → {user}
await api.auth.logout()
await api.auth.me()                               // → {user|null}
await api.me.update({nickname?, avatar?, bio?})   // → {user}

// 用户主页
await api.users.get(uuid)                         // → {user, relation}
await api.users.block(uuid) / api.users.unblock(uuid)

// 表白墙
await api.posts.list({cat, sort, q, cursor, limit})   // → {items, nextCursor, sort}
await api.posts.create({cat, body})                   // → {id, status}
await api.posts.like(id)                              // → {liked, likes}
await api.posts.comments(id)                          // → {items}
await api.posts.comment(id, body)                     // → {id, status}
await api.posts.report(postId, reason)

// 论坛
await api.forum.threads({board, sort, cursor, limit}) // → {items, nextCursor}
await api.forum.createThread({board, title, body})    // → {id, status}
await api.forum.thread(id)                            // → {thread, replies}
await api.forum.reply(id, body)                       // → {id, status}
await api.forum.like(id)                              // → {liked, likes}

// 好友 / 私信
await api.friends.list()                              // → {friends, incoming, outgoing}
await api.friends.request(uuid, message)              // → {ok:true}
await api.friends.accept(uuid) / api.friends.decline(uuid) / api.friends.remove(uuid)
await api.dm.conversations()                          // → {items, unread}
await api.dm.thread(uuid, cursor)                     // → {peer, items, nextCursor}
await api.dm.send(uuid, body)                         // → {id, createdAt}
await api.dm.unread()                                 // → {count}

// 其它
await api.feedback({cat, body, contact})
```

- 所有方法失败时 **throw `ApiError`**，含 `.status`、`.code`（服务端 error 码）、`.message`（中文、可直接 toast）。
- 需要登录的接口在未登录时抛 `code === 'login_required'`。UI 应调用
  `auth.requireLogin(() => 重试)`（见下）而不是自己弹登录。

## 6. 会话与登录上下文（LEAD 提供）

```jsx
import { useAuth } from '../context/AuthContext.jsx';
const { user, ready, refresh, logout, updateUser, requireLogin, openAuth, closeAuth, authOpen } = useAuth();
// user: null | {uuid, nickname, avatar, bio, school, title:{name,color}|null, level, exp, createdAt, stats}
// requireLogin(fn) —— 已登录直接执行 fn()；未登录则打开登录页，登录成功后自动执行 fn()
```

## 7. 用户展示组件（LEAD 提供）

```jsx
import { UserBadge } from '../components/UserBadge.jsx';
<UserBadge user={u} variant="full" />     // 学校 · 头衔 · Lv.N  （顺序固定：学校在前，等级在头衔之后）
<UserBadge user={u} variant="compact" />  // 学校 · 头衔            （省略等级）
<UserBadge user={u} variant="title" />    // 头衔 · Lv.N
<UserBadge user={u} variant="level" />    // Lv.N
// 学校为空/未登录 → 不渲染。头衔为空 → 跳过，不留下悬空的分隔符。

import { Avatar } from '../components/Avatar.jsx';
<Avatar user={u} size={40} />
```

## 8. 后端 API 契约（LEAD 实现）

统一约定：
- 除 `GET /api/health`、`GET /api/site`、`GET /api/schools`、`GET /api/posts*`、
  `GET /api/posts/:id/comments`、`GET /api/users/:uuid` 外，**其余接口都要求登录**
  （会话 cookie `od_session`，HttpOnly）。未登录返回 `401 {error:"login_required"}`。
- 限流命中 → `429 {error:"rate_limited", retryAfter}`。
- 参数错误 → `400 {error:"..."}`。字段名与 §5 客户端一一对应（camelCase）。

### 8.1 站点与公告

`GET /api/site` → 
```json
{
  "version": "1.0.0",
  "siteName": "校园墙",
  "emailConfigured": true,
  "features": { "forum": true, "dm": true },
  "announcements": [
    { "id": 3, "body": "期末周互助帖已开放", "link": "/forum", "linkText": "去看看" }
  ]
}
```

`GET /api/schools` → `{ "items": ["清华大学", "北京大学", ...] }`（只返回后台启用中的学校，按 sort、名称排序）

### 8.2 登录（邮箱验证码）

`POST /api/auth/code` `{ email }` → `{ ok:true, expiresIn:600, devCode?:string }`
- 发送 6 位数字验证码，10 分钟有效；同一邮箱 60 秒内只能发一次，每小时 ≤ 5 次；按 IP 限流。
- Cloudflare Email Sending REST API 发送。未配置时写控制台 + `server/data/outbox/`，
  且仅当 `NODE_ENV !== 'production'` 才在响应里回带 `devCode`。

`POST /api/auth/verify` `{ email, code }` →
- 老用户：`{ "user": {...} }` + `Set-Cookie: od_session=...`
- 新用户：`{ "needProfile": true, "token": "<一次性注册令牌, 15 分钟>", "email": "..." }`
- 失败：`401 {error:"invalid_code", remaining}` / `410 {error:"code_expired"}`

`POST /api/auth/register` `{ token, nickname, school, avatar? }` → `{ user }` + 会话 cookie
- `school` 必须在后台维护的 `schools` 表（active=1）内（空白归一后精确匹配），否则
  `400 {error:"invalid_school"}`；名单为空时返回 `409 {error:"schools_unavailable"}`（提示管理员尚未配置学校）。
- `nickname` 2–16 字，经本地预审：命中违禁词 → `400 {error:"nickname_rejected", flags}`（**拒绝**，不是进队列）。
- `token` 无效/过期 → `400 {error:"invalid_token"}`。

`POST /api/auth/logout` → `{ ok:true }`（清 cookie）
`GET /api/auth/me` → `{ user: User|null }`
`PATCH /api/me` `{ nickname?, avatar?, bio? }` → `{ user }`
- 昵称同样走预审；改名 7 天冷却（`400 {error:"nickname_cooldown", retryAfter}`）。
- `avatar` 为预设头像 key（见 `AVATARS`，白名单校验）。`bio` ≤ 60 字。

### 8.3 用户对象（所有接口共用）

```json
{
  "uuid": "8f1c…",
  "nickname": "小满",
  "avatar": "leaf",
  "bio": "喜欢在图书馆四楼靠窗",
  "school": "某某大学",
  "title": { "name": "学长", "color": "#0071e3" },
  "level": 7,
  "exp": 1560,
  "createdAt": 1750000000000,
  "stats": { "posts": 3, "comments": 12, "threads": 4, "friends": 6 }
}
```
本人可见额外字段：`email`、`nicknameCooldownUntil`。

`GET /api/users/:uuid` → `{ user, relation }`，
`relation` ∈ `self | none | friend | pending_out | pending_in | blocked | blocked_by`。

### 8.4 表白墙（匿名展示，登录才能写）

- `GET /api/posts?cat=&sort=new|hot&q=&cursor=&limit=` → `{items,nextCursor,sort}`，
  item: `{id, cat, body, likes, liked, comments, createdAt}`（**不含任何作者信息**）。
- `POST /api/posts` `{cat, body}` → `201 {id, status:"pending"}`
  **字数上限取消**：只要求 `body.trim().length >= 1`，上限由 `MAX_BODY`（32768）兜底。
- `POST /api/posts/:id/like` → `{liked, likes}`（按登录用户去重）
- `GET /api/posts/:id/comments` → `{items:[{id, body, createdAt}]}`（匿名）
- `POST /api/posts/:id/comments` `{body}` → `201 {id, status:"pending"}`，上限 300 字
- `POST /api/reports` `{postId, reason}`

### 8.5 论坛（显示昵称/头衔/等级）

- `GET /api/forum/threads?board=&sort=new|hot&cursor=&limit=` →
  `{items:[{id, board, title, excerpt, author:User, replyCount, likeCount, viewCount, liked, createdAt, lastReplyAt}], nextCursor}`
- `POST /api/forum/threads` `{board, title, body}` → `201 {id, status}`
  `title` 2–60 字，`body` 1–4000 字；命中预筛 → `pending`，否则 `approved`。
- `GET /api/forum/threads/:id` → `{thread:{...,author:User}, replies:[{id, body, author:User, createdAt}]}`
- `POST /api/forum/threads/:id/replies` `{body}` → `201 {id, status}`（1–1000 字）
- `POST /api/forum/threads/:id/like` → `{liked, likes}`
- `board` 白名单：`general | study | life | lost`（综合 / 学习 / 生活 / 失物）。
  **不需要登录也能看**，写操作需要登录。

### 8.6 好友与私信

- `GET /api/friends` → `{friends:[{user:User, message, createdAt}], incoming:[同], outgoing:[同]}`
  —— 三个数组统一是「关系项」包装，`message` 是加好友时留的验证消息（好友项上通常为空）。
  前端取用户对象时统一用 `item.user`（兼容写法 `item.user || item` 亦可）。
- `POST /api/friends/requests` `{uuid, message?}` → `201 {ok:true, status:"pending"}`；
  对方已向我发过请求 → 直接成为好友（`{ok:true, status:"accepted"}`）；已是好友 → `400 already_friends`；被拉黑 → `403 blocked`。
- `POST /api/friends/requests/:uuid/accept` → `{ok:true}`；`/decline` → `{ok:true}`
- `DELETE /api/friends/:uuid` → `{ok:true}`（解除好友；不删聊天记录）
- `POST /api/users/:uuid/block` → `{ok:true}`（拉黑：解除好友、拒收私信）
- `GET /api/dm/conversations` → `{items:[{peer:User, last:{body, createdAt, mine}, unread}], unread}`
- `GET /api/dm/:uuid?cursor=&limit=` → `{peer:User, items:[{id, body, mine, createdAt}], nextCursor}`
- `POST /api/dm/:uuid` `{body}` → `201 {id, createdAt}`（1–500 字；非好友不能发 → `403 not_friends`）
- `GET /api/dm/unread` → `{count}`

### 8.7 管理接口（`Authorization: Bearer <ADMIN_TOKEN>`）

- `GET /api/admin/users?q=&status=&cursor=&limit=` → `{items:[AdminUser], nextCursor}`
  AdminUser 含：`id, uuid, email, nickname, nicknameFlagged, school, avatar, bio, title, level, exp,
  status, createdAt, lastLoginAt, ipHash, uaHash, counts:{posts,comments,threads,replies,dms,friends}`
- `GET /api/admin/users/:id` → `{user: AdminUser, recent:{posts,threads,reports}}`
- `POST /api/admin/users/:id` `{action, value}`：
  `set_title`(value=titleId|null) `set_level` `set_exp` `set_status`(`active|muted|banned`)
  `rename` `clear_nickname_flag` `reset_exp`
- `GET /api/admin/titles` → `{items:[{id,name,color,minLevel,auto,sort,userCount}]}`
- `POST /api/admin/titles` `{name, color, minLevel, auto}` → `201 {id}`；`POST /api/admin/titles/:id` 更新；`POST /api/admin/titles/:id/delete`
- `GET /api/admin/schools` → `{items:[{id,name,sort,active,userCount,createdAt}]}`
- `POST /api/admin/schools` `{name, sort?}` → `201 {id}`（同名且已停用 → 重新启用）
- `POST /api/admin/schools/:id` `{name?, sort?, active?}`；`POST /api/admin/schools/:id/delete`
  （删除不影响已选该校的用户：`users.school` 存的是校名快照）
- `GET /api/admin/announcements` → `{items:[{id,body,link,linkText,active,sort,updatedAt}]}`
- `POST /api/admin/announcements` `{body, link?, linkText?}` → `201 {id}`；`POST /api/admin/announcements/:id`（更新/启停）；`POST /api/admin/announcements/:id/delete`
- 论坛审核并入既有队列：`GET /api/admin/queue?type=threads|replies`，
  `POST /api/admin/threads/:id/(approve|reject|remove)`、`POST /api/admin/replies/:id/(approve|reject|remove)`
- 既有：`stats / queue / bulk / audit / reports / feedback / posts/:id / shutdown` 全部保留。

## 9. 数据模型（SQLite，见 `server/schema.sql`）

新增表：`users`、`auth_codes`、`sessions`、`register_tokens`、`user_titles`、`schools`、`announcements`、
`forum_threads`、`forum_replies`、`thread_likes`、`friendships`、`dm_messages`。

改动既有表：
- `posts` / `comments` 增加 `user_id INTEGER`（可空，前台不展示，供后台追责）。
- `likes`：列 `ip_hash` 重命名为 `actor`，值 = `u:<uuid>`（登录用户）。
- `feedback`：保留（把「内测反馈」更名为「意见反馈」，不再有 beta 字样）。

删除：`server/src/gate.js`、`server/src/beta.js`、`web/src/context/GateContext.jsx`、
`web/src/lib/{gate,beta,seed}.js`、`web/src/components/{BetaBanner,BetaNotice,FeedbackSheet}.jsx`
（FeedbackSheet 由 ME 重写为通用反馈入口）、`web/src/styles/beta.css`、
`server/scripts/gate-test.js`、`school-confession-wall.html(.artifact.json)`、
`server/data/banned.txt.example`、`web/screenshots/*`。

## 10. 等级与头衔

- 经验：审核通过的帖子 +10、评论 +2、主题 +5、回复 +2、被点赞 +1、每日首次登录 +1。
- 等级（三角曲线，前 1 级 0 经验）：
  ```
  升到第 n 级所需累计经验 = 50 * (n-1) * n / 2      // L2=50, L3=150, L4=300, L5=500 …
  level(exp) = floor((sqrt(1 + 8*exp/50) - 1) / 2) + 1   // 上限 99
  ```
- 头衔：后台自定义 `{name, color, minLevel, auto}`。`auto=1` 时达到 `minLevel` 自动获得；
  管理员手动指定的头衔优先。展示顺序固定：**学校 → 头衔 → 等级**。

## 11. 审核口径

- 表白墙：保持**先审后发**（`pending` → 人工通过）。
- 论坛：默认**命中预筛才转人工**（`flagged → pending`，否则直接 `approved`），
  可用 `FORUM_PREMOD=1` 切回全量先审。理由：讨论区需要即时性，而预筛仍能兜住风险内容。
- 私信：不过预筛（点对点），但拉黑/非好友拦截 + 频率限制 + 后台可查。
- 昵称：命中违禁词**直接拒绝**（不同于内容）。
