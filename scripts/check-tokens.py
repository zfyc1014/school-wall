#!/usr/bin/env python3
"""
设计令牌一致性检查。

`web/src/styles/tokens.css` 与单文件原型 `school-confession-wall.html` 的 `:root`
必须逐字一致 —— 原型是 OpenDesign 的视觉基线，React 版是它的工程化实现。
一旦有人只改了其中一边，这个脚本会直接报出来。

用法：python scripts/check-tokens.py
退出码：0 = 一致；1 = 有差异
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，先把标准输出切到 UTF-8，避免中文与符号直接抛 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
PROTOTYPE = ROOT / "school-confession-wall.html"
TOKENS = ROOT / "web" / "src" / "styles" / "tokens.css"

DECL = re.compile(r"^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$")
ROOT_BLOCK = re.compile(r":root\s*\{(.*?)\}", re.S)


def read_tokens(path: Path) -> dict[str, str]:
    """
    只取**第一个** :root 块 —— 那是 Apple 设计系统的契约层。
    两个文件里都还有第二个 :root 块放派生变量（--container / --gutter / --accent-soft …），
    它们允许按各自布局实现调整（例如手机端 gutter 的覆盖方式不同），不参与契约校验。
    """
    text = path.read_text(encoding="utf-8")
    blocks = ROOT_BLOCK.findall(text)
    if not blocks:
        return {}
    out: dict[str, str] = {}
    for line in blocks[0].splitlines():
        m = DECL.match(line)
        if m:
            out[m.group(1)] = re.sub(r"\s+", " ", m.group(2)).strip()
    return out


def main() -> int:
    for path in (PROTOTYPE, TOKENS):
        if not path.exists():
            print(f"[FAIL] 找不到文件：{path}")
            return 1

    proto = read_tokens(PROTOTYPE)
    react = read_tokens(TOKENS)

    missing = sorted(set(proto) - set(react))
    extra = sorted(set(react) - set(proto))
    changed = sorted(k for k in set(proto) & set(react) if proto[k] != react[k])

    print(f"原型 school-confession-wall.html : {len(proto)} 个令牌")
    print(f"React  web/src/styles/tokens.css  : {len(react)} 个令牌")

    if not (missing or extra or changed):
        print("[OK] 设计令牌逐字一致")
        return 0

    if missing:
        print("\n[FAIL] React 缺少令牌：")
        for k in missing:
            print(f"    {k}: {proto[k]}")
    if extra:
        print("\n[FAIL] React 多出令牌（原型没有，属于新增设计决策，需同步回原型）：")
        for k in extra:
            print(f"    {k}: {react[k]}")
    if changed:
        print("\n[FAIL] 取值不一致：")
        for k in changed:
            print(f"    {k}\n      原型 : {proto[k]}\n      React: {react[k]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
