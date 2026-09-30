# 设计系统 · 校园表白墙（内测版 `0.9.0-beta.1`）

本文件记录视觉契约与实现映射。**`web/src/styles/tokens.css` 是唯一令牌来源**，
它逐字复制自单文件原型 `school-confession-wall.html` 的第一个 `:root` 块
（Apple 设计系统契约，53 个契约令牌）。改动视觉前请先读本文件。

> 一致性由脚本把守：`python scripts/check-tokens.py`（当前 53/53 逐字一致）。
> 脚本只校验两个文件的**第一个 `:root` 块**，也就是契约层。

---

## 1. 令牌契约

### 颜色

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#ffffff` | 卡片、吸顶导航底、抽屉底、内测标识条上的文字 |
| `--surface` | `#f5f5f7` | 页面底色、输入框底 |
| `--surface-warm` | `#fbfbfd` | 首屏内测公告底、备用暖白 |
| `--fg` | `#1d1d1f` | 主文字、选中态填充、内测标识条底 |
| `--fg-2` | `#424245` | 次级文字、公告正文 |
| `--muted` | `#6e6e73` | 说明文字、未选中图标 |
| `--meta` | `#86868b` | 时间戳、计数、占位符、门禁弹层的隐私说明 |
| `--border` | `#d2d2d7` | 强边框、hover 边框 |
| `--border-soft` | `#e8e8ed` | 卡片边框、分割线、输入框边框 |
| `--accent` | `#0071e3` | **唯一的强调色** |
| `--accent-on` | `#ffffff` | 强调色上的文字 |
| `--accent-hover` / `--accent-active` | `#0077ed` / `#0066cc` | 主按钮 hover / active |
| `--success` / `--warn` / `--danger` | `#16a34a` / `#eab308` / `#dc2626` | 状态点与错误文字（`--warn` 也用于首屏门禁轻提示的圆点） |

**强调色预算：每屏最多两处。** 页面主区的两处是「发布告白」主按钮与「喜欢」激活态；
顶栏「发布公约」是 ghost 按钮，刻意不着色。内测版新增的 UI 不额外占用强调色：
标识条用 `--fg` / `--bg` 反白，公告用 `--surface-warm` + `--fg-2`，
只有弹层里的主操作（门禁的「验证并继续」、反馈的「提交反馈」）复用 `.btn-primary`。

### 字体

| 令牌 | 栈 |
| --- | --- |
| `--font-display` | SF Pro Display → SF Pro Icons → Helvetica Neue → Helvetica → Arial |
| `--font-body` | SF Pro Text → SF Pro Icons → Helvetica Neue → Helvetica → Arial |
| `--font-mono` | SF Mono → ui-monospace → JetBrains Mono → Menlo → Monaco → Consolas |

全部 system-first，**不加载任何 Web Font**（低配 VPS、离线预览、内网部署都能零请求渲染；
内测版页面也不再加载任何第三方脚本或 iframe）。数字（时间、计数、字数、版本号）一律走
`--font-mono`，与原型一致 —— 内测标识条的版本徽标与门禁题面都用它。

### 字号 / 节奏

`--text-xs 12` · `--text-sm 14` · `--text-base 17` · `--text-lg 21` · `--text-xl 28` ·
`--text-2xl 40` · `--text-3xl 56` · `--text-4xl 80`（px）

`--leading-body 1.47`、`--leading-tight 1.05`、`--tracking-display -0.015em`。
大标题用 `--fs-h1: clamp(38px, 5.2vw, 66px)` / `--fs-h2: clamp(26px, 3vw, 38px)`。

间距 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48；区块纵向 100（桌面）/ 64（平板）/ 40（手机）。

### 形状与动效

- 圆角：`--radius-sm 8` · `--radius-md 12` · `--radius-lg 18` · `--radius-pill 980`
  （内测标识条的版本徽标与首屏门禁轻提示走 `--radius-pill`）
- 阴影：`--elev-raised 0 12px 32px rgba(0,0,0,.08)`；派生 `--shadow-card` / `--shadow-lift`
  （公告与轻提示用 `--shadow-card`）
- 焦点环：`--focus-ring 0 0 0 4px color-mix(in oklab, var(--accent), transparent 65%)`
- 时长：`--motion-fast 150ms` · `--motion-base 220ms`；曲线 `--ease-standard cubic-bezier(.28,0,.22,1)`
- `prefers-reduced-motion: reduce` 下关闭全部动画与过渡（已在冒烟测试中验证）

### 派生变量（第二个 `:root` / 各样式文件内）

`--container` `--gutter` `--accent-soft` `--accent-tint` `--fg-soft` `--fg-hair`
`--overlay` `--shadow-card` `--shadow-lift` `--fs-h1` `--fs-h2`
**全部用 `color-mix()` 从上面的令牌派生**，不引入 Bootstrap 式的 `--accent-50/300` 阶梯。

---

## 2. 样式文件分工

```
web/src/styles/
├─ tokens.css    契约层：颜色/字体/字号/间距/圆角/动效（53 个令牌，与原型逐字一致）
├─ global.css    reset、布局原语（.container/.section/.row/.meta/.eyebrow）、.reveal 入场动画
├─ chrome.css    顶栏、品牌、最新/最热分段控件、按钮体系（primary/secondary/ghost）
├─ wall.css      Hero、吸顶工具条、瀑布流、卡片、点赞/评论/举报、评论面板、CTA、页脚
├─ sheets.css    弹层与抽屉、发布表单、公约正文、Toast
├─ beta.css      内测版标识条、首屏公告、门禁弹层、单行输入、反馈弹层共用的小件
└─ mobile.css    ≤720px：底部标签栏、触摸目标 ≥44px、弹层转底部抽屉、安全区适配
```

`challenge.css` 已随 Turnstile 一并删除；它的位置由 `beta.css` 接管。所有共享类的定义
仍只有一处（例如 `.sheet` / `.sheet-head` / `.sheet-actions` 在 `sheets.css`，
`beta.css` 只负责内测版新增的结构）。

---

## 3. 组件与结构映射

`data-od-id` 全部保留，便于 OpenDesign 评论模式继续定位区块。

| 区块 | 组件 | 定位 |
| --- | --- | --- |
| 内测标识条 | `components/BetaBanner.jsx` | `data-od-id="beta-banner"`（`role="status"`，全站吸顶最上方） |
| 顶栏 | `components/Chrome.jsx` → `TopNav` | `data-od-id="topnav"` |
| 首屏 | `App.jsx` 内联 hero section | `data-od-id="hero"` |
| 首屏内测公告 | `components/BetaNotice.jsx` | `id="beta-notice"` + `data-od-id="beta-notice"` |
| 首屏门禁轻提示 | `App.jsx` 内联（`gate.required && !gate.verified` 时） | `.verify-note` |
| 工具条 | `components/Chrome.jsx` → `Toolbar` | `data-od-id="toolbar"` |
| 信息流 | `components/Wall.jsx` | `data-od-id="feed"`（每张卡 `post-<id>`） |
| 转化条 | `App.jsx` 内联 CTA section | `data-od-id="cta-strip"` |
| 页脚 | `components/Footer.jsx` → `Footer` | `data-od-id="footer"` |
| 移动标签栏 | `components/Footer.jsx` → `TabBar` | `data-od-id="tabbar"` |
| 发布抽屉 | `components/ComposerSheet.jsx` → `ComposerSheet` | `#composer` |
| 举报抽屉 | `components/ComposerSheet.jsx` → `ReportSheet` | `#report-sheet` |
| 发布公约 | `components/LegalSheet.jsx` | `#legal` |
| **内测门禁弹层** | `context/GateContext.jsx` 内的 `GateSheet` | `#gate`（`lib/gate.js` 的 `GATE_SHEET_ID`） |
| **内测反馈弹层** | `components/FeedbackSheet.jsx` | `#feedback` |
| 墙贴 | `components/PostCard.jsx` | `post-<id>` |

状态与副作用分别收在 `hooks/`：`useWall`（信息流状态机，含「载入更多」）、
`useComments`（评论按需加载）、`useSheet`（弹层行为：淡入、滚动锁、焦点陷阱、Esc、焦点归还）、
`useReveal`（入场动画）。**内测版只有一个 Provider：`context/GateContext.jsx`**
（门禁状态 + 由服务端下发的内测版元信息）；`ToastContext` 提供全局提示。
`ChallengeContext` / `IdentityContext` 已随 Turnstile 与实名功能一并删除。

数据层在 `data/adapters.js`：收到 `403 gate_required` 时调用门禁的 `ensureVerified()`
弹出门禁弹层，用户通过后**自动重试原请求一次**。

---

## 4. 设计决策与取舍

1. **单文件原型保留不动。** `school-confession-wall.html` 是 OpenDesign 的渲染产物与
   视觉基线（SHA-256 `50d8619a…4503d` 已校验未改动）。React 版是工程化实现，两者同源共存、
   共用同一套 `/api`，可通过 `INDEX_FILE` 切换对外入口。
2. **弹层常驻 DOM 而非条件挂载。** 用 CSS `visibility` 控制显隐，保留原型的淡入淡出，
   同时避免「关闭动画期间节点已卸载」造成的结构不确定与辅助技术误读 ——
   门禁弹层与反馈弹层沿用同一套 `.modal` / `.sheet` 机制。
3. **举报改为两步。** 原型点击即落工单（理由写死为「用户举报」）。React 版点「举报」
   只打开抽屉收集理由，提交才落工单 —— 收集到理由，且不会误触即投诉。
4. **点赞态本地记忆。** 后端只返回计数，不返回「我是否点过」，因此点赞态按帖子 id
   存在 `localStorage`，刷新后心形不会回弹；点赞采用乐观更新，失败回滚并提示。
5. **计数缩写保持原样。** `nfmt` 与原型逐字一致：1284 → `1.3k`、12840 → `13k`。
   因此单次点赞在小数量级上看不出差值，这是契约行为，不是 bug。
6. **首屏加「载入更多」。** 后端 keyset 分页每页 20 条（`lib/types.js` 的 `PAGE_SIZE`），
   数据超过一页时出现按钮；本地演示数据只有 8 条，因此默认不显示。
7. **不做深色模式。** 原型令牌只有浅色一套，`color-scheme: light` 显式声明，
   避免系统深色偏好把表单控件染黑、破坏视觉契约。
8. **内测公告可关闭，但按版本号重新出现。** 关闭状态记在 `localStorage` 的
   `od_beta_notice_v1`，**值是用户读过的内测版本号**而不是布尔值：
   同一版本内不再打扰，换版本（`BETA_VERSION`）时公告重新出现一次。
9. **门禁不阻断阅读。** 首屏只给一条可忽略的轻提示 + 一个可关闭的弹层，
   而不是全屏遮罩 —— 表白墙是「读多写少」的产品，把阅读挡在验证后面会显著降低可用性；
   写接口本来就有服务端强制闸门兜底（`403 gate_required`），不依赖前端。
10. **内测元信息由服务端下发。** 版本号、标识、首屏公告、反馈开关都来自
    `GET /api/gate/config` 的 `beta` 字段（`server/src/beta.js`），前端只保留兜底默认值
    （`web/src/lib/beta.js` 的 `BETA_FALLBACK`）—— 运营改文案不必重新构建前端。

---

## 5. 内测版新增 UI 与令牌约定

### 5.1 四个新增组件

| 组件 | 位置 | 类名 | 设计意图 |
| --- | --- | --- | --- |
| **顶部内测标识条** | 全站最上方（`BetaBanner`） | `.beta-banner` / `.beta-banner-inner` / `.beta-tag` / `.beta-text` / `.beta-actions` | 用 `--fg` 底 + `--bg` 字的反白窄带（`min-height: 34px`），常态可见但不遮挡内容。左侧是 mono 的版本徽标，右侧常驻三个入口：内测说明 / 内测反馈 / 输入邀请码（最后一个只在「需要门禁且尚未通过」时出现）。窄屏（≤720px）隐藏正文提示，优先保住标识与入口 |
| **首屏内测公告** | Hero 内（`BetaNotice`） | `.beta-notice` / `.beta-notice-head` / `.beta-notice-body` / `.beta-notice-foot` | `--surface-warm` 底 + `--border-soft` 边框 + `--shadow-card`，最大宽 640px。正文用 `--fg-2`，右上角一个 `icon-btn` 关闭；页脚一行 mono 小字说明「内测期间不收集手机号，也没有账号体系；内容仍然先审后发」，并提供「提交内测反馈」次级按钮 |
| **门禁弹层** | `GateSheet`（`GateContext.jsx`） | `.gate-sheet` / `.gate-items` / `.gate-item` / `.gate-q` / `.gate-answer` | 与发布抽屉同一套弹层语言（`.sheet` / `.sheet-head` / `.sheet-actions`），窄到 480px。题面与答案框同行（题面 mono、答案框居中），底部三个出口：换一道题 / 暂不验证，仅浏览 / 验证并继续。底部 `.stamp` 用 mono 小字说明「验证完全在本站完成：不加载任何第三方脚本、不保存原始 IP」 |
| **反馈弹层** | `FeedbackSheet.jsx` | `.sheet` + `.cat-select` / `.textarea` / `.text-input` / `.stamp` | 与举报抽屉同构但语义不同（反馈针对产品，不产生公开内容）。分类用 `.cat-select` 三选一（功能异常 / 改进建议 / 其它），正文带实时字数（`n / max`），联系方式**选填**并注明「留了才能回复你」 |

另外两个复用件放在 `beta.css`：首屏门禁轻提示 `.verify-note`（药丸形、`--bg` 底、
`--warn` 圆点、`--radius-pill`）与发布抽屉内的 `.composer-verify`（只在未通过门禁时出现）。
单行输入 `.text-input` 也定义在 `beta.css`，与 `.textarea` 共用同一套视觉语言
（`--surface` 底、`--border-soft` 边框、focus 时 `--accent` 边框 + `--focus-ring`）。

### 5.2 令牌使用约定（新增 UI 必须遵守）

1. **颜色只能用 `tokens.css` 的令牌派生，不得新增颜色字面量。**
   需要透明度时统一用 `color-mix(in oklab, var(--token) N%, transparent)` ——
   `beta.css` 里反白文字的次级色就是这么写的（`color-mix(in oklab, var(--bg) 78%, transparent)`）。
   已核对：`web/src/styles/*.css` 中除 `tokens.css` 外**没有任何 `#hex` / `rgb()` / `hsl()` 字面量**
   （`--elev-raised` 的 `rgba(0,0,0,.08)` 属于契约层）。
2. **不得新增契约令牌。** `scripts/check-tokens.py` 逐字比对 `tokens.css` 与原型
   `school-confession-wall.html` 的**第一个 `:root` 块**（当前各 53 个）：React 侧多一个、
   少一个或取值不同都会直接失败。要在内测版 UI 上做新配色，请用第二个 `:root` 块或文件内的
   派生变量（那部分不参与契约校验），并保持「从既有令牌派生」这条原则。
3. **强调色预算不破。** 内测版新增 UI 只在弹层的主操作上使用 `.btn-primary`；
   标识条、公告、轻提示一律不着色，避免和页面主区的两处强调色抢注意力。
4. **状态色只做语义提示。** `--warn` 用于「需要验证」的圆点，`--danger` 用于错误文字
   （门禁的错误提示走 `.err`），成功态不加装饰性动效。
5. **动效走既有令牌。** 弹层淡入淡出仍由 `useSheet` + `--motion-base` 驱动；
   `prefers-reduced-motion: reduce` 下不新增任何独立动画。
6. **窄屏优先级固定。** ≤720px 时：标识条只留版本徽标 + 入口、公告页脚竖排、
   轻提示按钮拉满宽、门禁弹层转全宽底部抽屉（已在 `beta.css` 的媒体查询里实现）。
