#!/usr/bin/env python3
"""从 maimai DX 客户端资源里提取段位認定（Dani Mode）结算页用到的贴图。

这是**开发工具**，不是应用依赖：仓库里已经放好了提取结果
（public/assets/maimai/*.png），只有要重新提一遍时才跑它。

用法：
    pip install UnityPy texture2ddecoder Pillow
    python scripts/extract-maimai-assets.py "<游戏目录>" [输出目录]

`<游戏目录>` 是客户端里含 `resources.assets` 的那一层，例如
    E:/Downloads/156Sinmai_Data/156Sinmai_Data/156Sinmai_Data

为什么要这么提：段位認定结算那整屏是**成品图**（页头文字、格纹页眉、两侧水引、
下半部色带与合格印白框全部烘焙在底图里），运行时只是把逐题行、达成率数字盖上去。
所以页面直接用这张底图 + 几件小素材，比自己用 CSS 画近似得多。
"""
from __future__ import annotations

import sys
from pathlib import Path

import UnityPy

# 仓库里用的文件名 ← 游戏里的贴图名。只搬这几件，不是整个 UI_DNM 家族（159 张）。
WANTED: dict[str, str] = {
    "UI_DNM_Result_Base_01": "result-dani.png",       # 「段位認定」整屏底图 980×928
    "UI_DNM_Result_Base_03": "result-random.png",     # 「ランダム段位認定」整屏底图
    "UI_DNM_Result_musicBase_01": "track-plate.png",  # 逐题行底板 576×124
    "UI_DNM_Icon_Result_01": "stamp-clear.png",       # 逐题「可」印 108×108
    "UI_DNM_Icon_Result_02": "stamp-fail.png",        # 逐题「不可」印
    "UI_DNM_Icon_Clear": "verdict-clear.png",         # 「合格」252×104
    "UI_DNM_Icon_NoClear": "verdict-fail.png",        # 「不合格…」220×64
}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    game_dir = Path(argv[1])
    out_dir = Path(argv[2]) if len(argv) > 2 else Path("public/assets/maimai")
    assets = game_dir / "resources.assets"
    if not assets.exists():
        print(f"找不到 {assets}")
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    env = UnityPy.load(str(assets))
    written: dict[str, str] = {}
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        name = getattr(data, "m_Name", None) or getattr(data, "name", "") or ""
        target = WANTED.get(name)
        if target is None or target in written:
            continue
        image = data.image
        image.save(out_dir / target)
        written[target] = f"{name} ({image.width}x{image.height})"

    for target in WANTED.values():
        print(f"  {written.get(target, '缺失！'):<34} → {target}")
    return 0 if len(written) == len(WANTED) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))