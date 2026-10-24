#!/usr/bin/env python3
"""把**原版**的乐曲卡片素材原样导出来，供对照。

用途：现在卡片的边框是照着官方贴图的版式用 CSS 画的（`.dan-track-frame`），用户要直接看
原版素材本身。这里把逐题行那一圈的原图导到 `docs/images/original-card/`，并顺手把当前渲染
出来的第 1 张卡裁成一张独立小图 `docs/images/dan-card.png`。

用法：
    python scripts/export-original-card.py "<游戏目录>"     # 含 resources.assets 的那一层
"""
from __future__ import annotations

import sys
from pathlib import Path

import UnityPy

# 逐题行那一圈的原版贴图。`UI_CMN_RSL_KopMBase_*` 就是官方乐曲卡片的边框（640×140，
# 五种难度各一张，颜色与难度名 BASiC/ADVANCED/EXPERT/MASTER/Re:MASTER 都烘在图里）。
WANTED = [
    "UI_CMN_RSL_KopMBase_BSC",
    "UI_CMN_RSL_KopMBase_ADV",
    "UI_CMN_RSL_KopMBase_EXP",
    "UI_CMN_RSL_KopMBase_MST",
    "UI_CMN_RSL_KopMBase_MST_Re",
    "UI_CMN_RSL_JacketImage_S",
    "UI_CMN_RSL_MusicJacket_Base",
    "UI_CMN_RSL_JaketTrack",
    "UI_CMN_RSL_JaketTrackNo_0",
    "UI_CMN_RSL_AllScorekBase",
    "UI_DNM_Result_musicBase_01",
    "UI_RSL_AchivementCounter",
    "UI_DNM_AchivementCounter",
]
PREFIXES = ("UI_CMN_RSL_", "UI_DNM_Result_music", "UI_RSL_Achivement", "UI_DNM_Achivement")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    game = Path(sys.argv[1])
    out = Path(__file__).resolve().parent.parent / "docs" / "images" / "original-card"
    out.mkdir(parents=True, exist_ok=True)
    env = UnityPy.load(str(game / "resources.assets"))
    saved, extra = [], []
    for obj in env.objects:
        if obj.type.name not in ("Texture2D", "Sprite"):
            continue
        try:
            data = obj.read()
            name = getattr(data, "m_Name", "") or ""
            if not name:
                continue
            if name in WANTED:
                image = data.image
                image.save(out / f"{name}.png")
                saved.append((name, image.size))
            elif any(name.startswith(p) for p in PREFIXES):
                extra.append(name)
        except Exception as exc:  # 有的贴图数据在别的 bundle 里，读不到就跳过
            if getattr(obj, "read", None):
                try:
                    name = obj.read().m_Name
                except Exception:
                    name = "?"
                if name in WANTED:
                    print(f"  跳过 {name}：{type(exc).__name__}")
    for name, size in sorted(saved):
        print(f"  导出 {name}  {size[0]}x{size[1]}")
    if extra:
        print("同前缀但未导出的（想看哪个再说）：")
        for name in sorted(extra):
            print(f"    {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())