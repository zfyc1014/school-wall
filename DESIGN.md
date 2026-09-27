# 设计系统 · 校园表白墙

本文件记录视觉契约与实现映射。**`web/src/styles/tokens.css` 是唯一令牌来源**，
它逐字复制自单文件原型 `school-confession-wall.html` 的第一个 `:root` 块
（Apple 设计系统契约，53 个契约令牌）。改动视觉前请先读本文件。

> 一致性由脚本把守：`python scripts/check-tokens.py`（当前 53/53 逐字一致）。

---

## 1. 令牌契约

### 颜色

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#ffffff` | 卡片、吸顶导航底、抽屉底 |
| `--surface` | `#f5f5f7` | 页面底色 |
| `--surface-warm` | `#fbfbfd` | 备用暖白（当前未使用，保留契约） |
| `--fg` | `#1d1d1f` | 主文字、选中态填充、Toast 底 |
| `--fg-2` | `#424245` | 次级文字、正文脚注 |
| `--muted` | `#6e6e73` | 说明文字、未选中图标 |
| `--meta` | `#86868b` | 时间戳、计数、占位符 |
| `--border` | `#d2d2d7` | 强边框、hover 边框 |
| `--border-soft` | `#e8e8ed` | 卡片边框、分割线 |
| `--accent` | `#0071e3` | **唯一的强调色** |
| `--accent-on` | `#ffffff` | 强调色上的文字 |
| `--accent-hover` / `--accent-active` | `#0077ed` / `#0066cc` | 主按钮 hover / active |
| `--success` / `--warn` / `--danger` | `#16a34a` / `#eab308` / `#dc2626` | 状态点与错误文字 |

**强调色预算：每屏最多两处。** 当前页面的两处是「发布告白」主按钮与
「喜欢」激活态；顶栏「发布公约」是 ghost 按钮，刻意不着色。

### 字体

| 令牌 | 栈 |
| --- | --- |
| `--font-display` | SF Pro Display → SF Pro Icons → Helvetica Neue → Helvetica → Arial |
| `--font-body` | SF Pro Text → SF Pro Icons → Helvetica Neue → Helvetica → Arial |
| `--font-mono` | SF Mono → ui-monospace → JetBrains Mono → Menlo → Monaco → Consolas |

全部 system-first，**不加载任何 Web Font**（低配 VPS 与离线预览都能零请求渲染）。
数字（时间、计数、字数）一律走 `--font-mono`，与原型一致。

### 字号 / 节奏

`--text-xs 12` · `--text-sm 14` · `--text-base 17` · `--text-lg 21` · `--text-xl 28` ·
`--text-2xl 40` · `--text-3xl 56` · `--text-4xl 80`（px）

`--leading-body 1.47`、`--leading-tight 1.05`、`--tracking-display -0.015em`。
大标题用 `--fs-h1: clamp(38px, 5.2vw, 66px)` / `--fs-h2: clamp(26px, 3vw, 38px)`。

间距 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48；区块纵向 100（桌面）/ 64（平板）/ 40（手机）。

### 形状与动效

- 圆角：`--radius-sm 8` · `--radius-md 12` · `--radius-lg 18` · `--radius-pill 980`
- 阴影：`--elev-raised 0 12px 32px rgba(0,0,0,.08)`；派生 `--shadow-card` / `--shadow-lift`
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
├─ challenge.css 人机验证：首屏提示条、验证弹层、widget 容器、发布抽屉内联验证
└─ mobile.css    ≤720px：底部标签栏、触摸目标 ≥44px、弹层转底部抽屉、安全区适配
```

---

## 3. 组件与结构映射

`data-od-id` 全部保留，便于 OpenDesign 评论模式继续定位区块。

| 区块 | 组件 | `data-od-id` |
| --- | --- | --- |
| 顶栏 | `components/Chrome.jsx` → `TopNav` | `topnav` |
| 首屏 | `App.jsx` 内联 hero section | `hero` |
| 工具条 | `components/Chrome.jsx` → `Toolbar` | `toolbar` |
| 信息流 | `components/Wall.jsx` | `feed`（每张卡 `post-<id>`） |
| 转化条 | `App.jsx` 内联 CTA section | `cta-strip` |
| 页脚 | `components/Footer.jsx` → `Footer` | `footer` |
| 移动标签栏 | `components/Footer.jsx` → `TabBar` | `tabbar` |
| 发布抽屉 | `components/ComposerSheet.jsx` → `ComposerSheet` | `#composer` |
| 举报抽屉 | `components/ComposerSheet.jsx` → `ReportSheet` | `#report-sheet` |
| 发布公约 | `components/LegalSheet.jsx` | `#legal` |
| 人机验证闸门 | `context/ChallengeContext.jsx` + `components/Turnstile.jsx` | `#challenge` |
| 墙贴 | `components/PostCard.jsx` | `post-<id>` |

状态与副作用分别收在 `hooks/`：`useWall`（信息流状态机）、`useComments`（评论按需加载）、
`useSheet`（弹层行为：淡入、滚动锁、焦点陷阱、Esc、焦点归还）、`useReveal`（入场动画）。
人机验证状态在 `context/ChallengeContext.jsx`，数据层在 `data/adapters.js`。

---

## 4. 设计决策与取舍

1. **单文件原型保留不动。** `school-confession-wall.html` 是 OpenDesign 的渲染产物与
   视觉基线（SHA-256 `50d8619a…4503d` 已校验未改动）。React 版是新增的工程化实现，
   两者同源共存、共用同一套 `/api`，可通过 `INDEX_FILE` 切换对外入口。
2. **弹层常驻 DOM 而非条件挂载。** 用 CSS `visibility` 控制显隐，保留原型的淡入淡出，
   同时避免「关闭动画期间节点已卸载」造成的结构不确定与辅助技术误读。
3. **举报改为两步。** 原型点击即落工单（理由写死为「用户举报」）。React 版点「举报」
   只打开抽屉收集理由，提交才落工单 —— 收集到理由，且不会误触即投诉。
4. **点赞态本地记忆。** 后端只返回计数，不返回「我是否点过」，因此点赞态按帖子 id
   存在 `localStorage`，刷新后心形不会回弹；点赞采用乐观更新，失败回滚并提示。
5. **计数缩写保持原样。** `nfmt` 与原型逐字一致：1284 → `1.3k`、12840 → `13k`。
   因此单次点赞在小数量级上看不出差值，这是契约行为，不是 bug。
6. **首屏加「载入更多」。** 后端 keyset 分页每页 20 条（`PAGE_SIZE`），
   数据超过一页时出现按钮；本地演示数据只有 8 条，因此默认不显示。
7. **不做深色模式。** 原型令牌只有浅色一套，`color-scheme: light` 显式声明，
   避免系统深色偏好把表单控件染黑、破坏视觉契约。

---

## 5. 人机验证的视觉处理

Turnstile 是第三方 iframe，样式不可控，因此设计上只做两件事：**给它一个稳定的容器**，
以及**不打断阅读**。

| 元素 | 类名 | 设计意图 |
| --- | --- | --- |
| 首屏提示条 | `.verify-note` | 药丸形、白底、`--warn` 圆点。明确写「浏览无需验证；发布、评论、举报前需先完成一次人机验证」，并给一个「立即验证」次级按钮 —— 不阻断阅读 |
| 验证弹层 | `#challenge` → `.challenge-sheet` | 与发布抽屉同一套弹层语言（`.sheet` / `.sheet-head`），窄到 460px；底部提供「暂不验证，仅浏览」出口 |
| widget 容器 | `.turnstile-box` | `--surface` 底 + `--border-soft` 边框，`min-height: 74px` 预留高度，避免 iframe 加载完成时页面跳动 |
| 隐私说明 | `.challenge-sheet .stamp` | 用 mono 小字说明「由 Cloudflare 提供、不读取账号信息、不保存原始 IP」 |
| 发布内联验证 | `.composer-verify` | 只在「需要验证且尚未验证」时出现；已验证用户发布时不会再被打断一次 |

一致性上的两个取舍：

1. **不新增颜色。** 提示条的圆点复用 `--warn`，按钮复用 `.btn-secondary`；
   强调色预算仍然是「主按钮 + 点赞激活态」两处，验证相关 UI 不占用。
2. **不引入遮罩层做入口闸门。** 用可关闭的弹层而不是全屏拦截，
   因为表白墙是「读多写少」的产品：把阅读挡在验证后面会显著降低可用性，
   而写接口本来就有服务端强制闸门兜底。
