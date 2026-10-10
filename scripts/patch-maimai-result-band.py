#!/usr/bin/env python3
"""把段位認定结算底图下半部那几块「挖白」的面板按底图花纹续画填掉。

这是**开发工具**，同 extract-maimai-assets.py：仓库里 public/assets/maimai/result-dani.png
与 result-random.png 已经是补过的。只有重新提取底图（会把挖白带回来）之后才需要再跑一遍：

    python scripts/extract-maimai-assets.py "<游戏目录>"
    python scripts/patch-maimai-result-band.py

为什么要补：底图下半部那条色带里有三块**挖白的空面板**（(503,663) 213×52、
(753,677) 104×38、(608,810) 360×80）—— 那是原作留给运行时贴图的位置（标签、按钮一类），
运行时它们会被盖住，所以底图上就留了白。我们不需要显示那么多信息，白块露出来只会看着
像「空框」，所以按底图自己的花纹把这几块填回去。

怎么补：色带是平涂的竖向色块 + 斜向橙色折线（chevron），水平方向**严格周期**——
把干净区跟自身平移 p 列比差，p=115 时平均差只有 2.8（再往上都是倍频），所以整块矩形
都能从 x±k·115 的同相位列搬过来，折线与色块接缝都能对上。

不用「按阈值抠白像素」那套：挖白边缘有一圈半透明的浅灰（跟底色混出来的），按阈值抠
总会漏一圈光晕；直接按连通域量出来的矩形（外扩 3px）整块替换更干净。取色列避开画布
左右边框（会有深红边框）与左下角那块段位名牌 —— 那一格保留，页面拿它盖合格印。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 三块挖白面板：连通域量出来的外框
HOLES = (
    (503, 663, 716, 715),      # 色带上沿左边那块
    (753, 677, 857, 715),      # 色带上沿右边那块
    (608, 810, 968, 890),      # 右下角那一大块
)
PAD = 3                        # 外扩，吃掉边缘那圈半透明浅灰
PLATE = (74, 672, 315, 903)    # 左下角段位名牌：保留
XMIN, XMAX = 12, 950           # 取色列的安全范围
BAND_TOP, BAND_BOTTOM = 662, 901   # 量周期用的干净区
FILES = ("result-dani.png", "result-random.png")


def period(strip: np.ndarray) -> int:
    """干净区自比，取平均差最小的平移量。"""
    clean = np.ones(strip.shape[:2], bool)
    clean[:, :330] = False
    clean[:, 951:] = False
    for x0, y0, x1, y1 in HOLES:
        clean[max(0, y0 - BAND_TOP - 6):y1 - BAND_TOP + 7, max(0, x0 - 6):x1 + 7] = False
    best, best_value = 0, float("inf")
    for p in range(60, 180):
        mask = clean[:, :-p] & clean[:, p:]
        if mask.sum() < 2000:
            continue
        diff = np.abs(strip[:, :-p] - strip[:, p:]).mean(axis=2)
        value = float(diff[mask].mean())
        if value < best_value - 1e-9:
            best, best_value = p, value
    return best


def patch(path: Path) -> None:
    art = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    height, width = art.shape[:2]
    hole = np.zeros((height, width), bool)
    for x0, y0, x1, y1 in HOLES:
        hole[max(0, y0 - PAD):y1 + PAD + 1, max(0, x0 - PAD):x1 + PAD + 1] = True
    hole[PLATE[1]:PLATE[3], PLATE[0]:PLATE[2]] = False

    # 已经补过的图不要再补：填色是从原图取的，第二次跑会拿上一次填出来的像素当源，
    # 沿着折线边缘累积出一两像素的漂移。
    white = (art >= 246).all(axis=2) & hole
    if white.sum() < hole.sum() * 0.02:
        print("  %-20s 没有挖白了（已补过），跳过" % path.name)
        return

    p = period(art[BAND_TOP:BAND_BOTTOM])
    filled = art.copy()
    for y, x in zip(*np.nonzero(hole)):
        for k in (1, 2, 3, 4):
            hit = False
            for cand in (x - k * p, x + k * p):
                in_plate = PLATE[0] <= cand < PLATE[2] and PLATE[1] <= y < PLATE[3]
                if XMIN <= cand <= XMAX and not hole[y, cand] and not in_plate:
                    filled[y, x] = art[y, cand]
                    hit = True
                    break
            if hit:
                break
    Image.fromarray(filled.astype(np.uint8)).save(path)
    print("  %-20s 周期 %d，补了 %d 像素" % (path.name, p, int(hole.sum())))


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("public/assets/maimai")
    for name in FILES:
        target = out / name
        if not target.exists():
            print("  少了 %s，跳过" % target, file=sys.stderr)
            continue
        patch(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())