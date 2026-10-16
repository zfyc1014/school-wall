#!/usr/bin/env python3
"""
设计系统一致性检查（v1.0.0）。

原来这个脚本把 tokens.css 与单文件原型 school-confession-wall.html 逐字比对；
v1.0.0 删掉了原型（属于示例内容），改为检查**设计系统自身的规则**：

  1. tokens.css 必须定义全部必需令牌（少一个就会有组件悄悄用上浏览器默认值）；
  2. 所有 CSS/JSX 里 var(--x) 引用的令牌都必须真实存在（防拼写错误导致样式静默失效）；
  3. 除 tokens.css 之外，任何 CSS 文件都不许出现颜色字面量（#hex / rgb() / hsl()）
     —— 颜色只能来自令牌，否则深色模式必然有漏网之处。

用法：python scripts/check-tokens.py
退出码：0 = 通过；1 = 有违规
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
STYLES = SRC / "styles"
TOKENS_FILE = STYLES / "tokens.css"

DECL = re.compile(r"^\s*(--[a-z0-9-]+)\s*:", re.M)
VAR_USE = re.compile(r"var\(\s*(--[a-z0-9-]+)")
COLOR_LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(")

# 组件依赖的最小令牌集：少一个就会出现「某一处在深色模式下瞎掉」
REQUIRED = [
    "--bg", "--surface", "--surface-2", "--fg", "--fg-2", "--muted", "--meta",
    "--border", "--border-soft", "--accent", "--accent-on", "--accent-hover",
    "--success", "--warn", "--danger", "--danger-on", "--like",
    "--glass-bg", "--glass-bg-strong", "--glass-border", "--glass-blur", "--glass-saturate",
    "--font-body", "--font-display",
    "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6",
    "--radius-sm", "--radius-md", "--radius-lg", "--radius-pill",
    "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg",
    "--content-max", "--gutter", "--dock-h", "--dock-safe", "--tap",
    "--shadow-card", "--shadow-sheet", "--motion-fast", "--motion-base", "--ease",
]


BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"(?m)^\s*//.*$")


def strip_comments(text: str) -> str:
    return LINE_COMMENT.sub("", BLOCK_COMMENT.sub("", text))


def main() -> int:
    if not TOKENS_FILE.exists():
        print(f"[FAIL] 找不到 {TOKENS_FILE}")
        return 1

    defined = set(DECL.findall(TOKENS_FILE.read_text(encoding="utf-8")))
    problems: list[str] = []

    missing = [name for name in REQUIRED if name not in defined]
    if missing:
        problems.append("tokens.css 缺少必需令牌：\n" + "\n".join(f"    {n}" for n in missing))

    undefined: dict[str, set[str]] = {}
    css_files = sorted(SRC.rglob("*.css"))
    jsx_files = sorted(SRC.rglob("*.jsx"))
    for path in css_files + jsx_files:
        # 注释里出现的 var(--x) 只是说明性文字（例如「需要新变体时用 var(--x) 派生」），
        # 不参与引用检查 —— 否则每次写示例都要被自己的检查器拦下来。
        text = strip_comments(path.read_text(encoding="utf-8"))
        for name in VAR_USE.findall(text):
            if name not in defined:
                undefined.setdefault(name, set()).add(path.relative_to(ROOT).as_posix())
    if undefined:
        lines = [f"    {name}  ←  {', '.join(sorted(files))}" for name, files in sorted(undefined.items())]
        problems.append("引用了未定义的令牌：\n" + "\n".join(lines))

    offenders = []
    for path in css_files:
        if path.name == "tokens.css":
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if COLOR_LITERAL.search(line):
                offenders.append(f"    {path.relative_to(ROOT).as_posix()}:{lineno}  {line.strip()[:80]}")
    if offenders:
        problems.append("颜色字面量必须收敛到 tokens.css：\n" + "\n".join(offenders))

    print(f"令牌总数：{len(defined)}（tokens.css）")
    print(f"检查范围：{len(css_files)} 个 CSS + {len(jsx_files)} 个 JSX")

    if not problems:
        print("[OK] 设计系统检查通过")
        return 0

    for block in problems:
        print("\n[FAIL] " + block)
    return 1


if __name__ == "__main__":
    sys.exit(main())
