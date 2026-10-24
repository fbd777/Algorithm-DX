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
下半部色带与左下角段位名牌白框全部烘焙在底图里），运行时只是把逐题行、达成率数字、
段位名与总达成率盖上去。所以页面直接用这张底图 + 几件小素材，比自己用 CSS 画近似得多。
注意：底图下半部那两三块**挖白的空面板**是原作留给运行时文字的位置，不要再拿别的脚本
把它们续画填掉（第 12 轮干过一次，第 13 轮撤了）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import UnityPy

# 仓库里用的文件名 ← 游戏里的贴图名。只搬这几件，不是整个 UI_DNM 家族（159 张）。
#
# 故意**不**搬的一件：逐题行的乐曲边框 `UI_CMN_RSL_KopMBase_{BSC,ADV,EXP,MST,MST_Re}`
# （640×140，五种难度各一张）。它是逐题行那一圈底色，但颜色与难度名（BASIC/ADVANCED/
# EXPERT/MASTER/Re:MASTER）都烘死在图里，套不上我们自己的 CF 难度分档。所以边框按它的
# 版式用 CSS 画一层（见 dan.css 的 .dan-track-frame）：外圈浅色环 + 主色场 + 底部浅色带
# + 左侧白曲绘槽 + 深蓝标题条 + 白色达成率框，尺寸全按这张贴图量出来的像素。
WANTED: dict[str, str] = {
    "UI_DNM_Result_Base_01": "result-dani.png",       # 「段位認定」整屏底图 980×928
    "UI_DNM_Result_Base_03": "result-random.png",     # 「ランダム段位認定」整屏底图
    "UI_DNM_Result_musicBase_01": "track-plate.png",  # 逐题行底板 576×124
    "UI_DNM_Icon_Result_01": "stamp-clear.png",       # 逐题「可」印 108×108
    "UI_DNM_Icon_Result_02": "stamp-fail.png",        # 逐题「不可」印
    # 数字图集：规整 4×4 网格，逐格由同名 Sprite 定 rect（见 dan.js 的 NUM_FONTS）。
    # 图集里全是**纯白剪影**（游戏运行时才染色），所以描边要另外提一层 _Outline。
    "UI_CMN_Num_26p": "num-26p.png",                  # 小号数字 136×160，格 34×40
    "UI_CMN_Num_26p_Outline": "num-26p-outline.png",  #   同布局的描边剪影
    "UI_CMN_Num_90p": "num-90p.png",                  # 没有成绩时的占位「—」用，356×420，格 89×105
    "UI_CMN_Num_90p_Outline": "num-90p-outline.png",
    # 分数数字：同布局的三套（blue / gold / red）296×392，格 74×98，自带颜色、
    # 不用描边层 —— 原作就是按达成率高低换这一套的颜色。
    # 同名的 `UI_NUM_Score_0001111_Base` 故意不搬：那是一张**空图集**（16 格里一个字形都没有，
    # 整张只有几列杂散像素），照它渲染数字会得到一片看不见的灰影。
    "UI_NUM_Score_0001111_Blue": "num-score-blue.png",
    "UI_NUM_Score_0001111_Gold": "num-score-gold.png",
    "UI_NUM_Score_0001111_Red": "num-score-red.png",
    # 达成率末尾那个大「%」字形：同样按分数分色（没有 base 那版，低档用图集里的 % 格）
    "UI_RSL_Score_Per_Gold": "score-per-gold.png",     # 80×80
    "UI_RSL_Score_Per_Blue": "score-per-blue.png",
    "UI_RSL_Score_Per_Red": "score-per-red.png",
    # 逐题评级徽章：`UI_GAM_Rank_*` 是**游戏内**那套，单级各一张（源图紧裁，36–110 × 42–44）。
    # 故意不用 `UI_CMN_TabTitle_Rank_*`：那是**页签标题**上的区间图 —— AAA 那张画的是
    # 「A～AAA」、BBB 是「～BBB」，而且它没有 D/C/B/BB/A/AA，低分全挤在同一张牌上。
    "UI_GAM_Rank_D": "gam-rank-d.png",
    "UI_GAM_Rank_C": "gam-rank-c.png",
    "UI_GAM_Rank_B": "gam-rank-b.png",
    "UI_GAM_Rank_BB": "gam-rank-bb.png",
    "UI_GAM_Rank_BBB": "gam-rank-bbb.png",
    "UI_GAM_Rank_A": "gam-rank-a.png",
    "UI_GAM_Rank_AA": "gam-rank-aa.png",
    "UI_GAM_Rank_AAA": "gam-rank-aaa.png",
    "UI_GAM_Rank_S": "gam-rank-s.png",
    "UI_GAM_Rank_Sp": "gam-rank-sp.png",
    "UI_GAM_Rank_SS": "gam-rank-ss.png",
    "UI_GAM_Rank_SSp": "gam-rank-ssp.png",
    "UI_GAM_Rank_SSS": "gam-rank-sss.png",
    "UI_GAM_Rank_SSSp": "gam-rank-sssp.png",
    # 右下角那个组件：剩余生命底盘（绿 = 通关 / 红 = 未通关）。
    # `UI_RSL_DXScore_Base`（「でらっくスコア」标签）**故意不搬**：官方那格是单曲按打击
    # 精度算的 DX 分数，我们显示的是四道单题 rating 之和，口径不同，套那个框等于撒谎。
    "UI_DNM_Base_Life_01": "life-base-green.png",
    "UI_DNM_Base_Life_03": "life-base-red.png",
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