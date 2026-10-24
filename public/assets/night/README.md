# assets/night —— 夜版背景贴图

夜版背景用的素材：结构和参数都还是官网那份 `style.css`，只是把 `vendor/maimai/img/prism/bg/`
里那几张贴图按夜色重画了一遍。谁换哪一张、在哪个断点换，写在 `public/theme-night.css` 里。

## 来源与做法

- 底图来自 `public/vendor/maimai/img/prism/bg/**`（官方原图，未改动；字节与 MD5 见那份 MANIFEST）。
- 重上色是离线做的一次性步骤：按原图的亮度分层，把白/亮部压成夜蓝、保留原来的粉/橙描边。
  做法与每个参数的来由写在生成脚本的注释里；生成脚本是一次性的本地工具，没有进仓库。
- **带 `-sp` / `-pc` 的素材必须跟着官方的断点走**：官方在基础规则里用 `_sp`、在
  `@media (min-width:769px)` 里换成 `_pc`（尺寸也各不相同）。只出一份的话，宽屏会拿手机那张
  顶 PC 那格 —— 彩虹两端那片云的 SP 版是被图片边界切平的窄裁版（左右两边 85% / 44% 的像素
  是实心的），铺进 PC 那格就会在画面中间露出两条平直的切边。
- 三处贴图在夜里额外淡了边，都是「官方素材被图片边界切平、白天靠底色看不出来、夜里露出来」这一类：
  彩虹两端那片云的 PC 版底边淡 12%、曙光两端各淡 4%（`repeat-x` 的接缝）、彩虹后面那片云两端各淡 6%。
- 月亮和流星直接用官方素材，没有派生版本（夜里它们本来就该是最亮的）。

## 文件

| 文件 | 对应官方贴图 | 说明 |
| --- | --- | --- |
| `sky-frame.png` | — | `.bg` 圆角外那圈底色（官方是 CSS 渐变，这里做成一条竖向贴图） |
| `sky.png` | — | `.bg--gradient` 的内层渐变，同上 |
| `pattern.png` | `bg_pattern.png` | 渐变上的图案叠加 |
| `shines-sp.png` / `shines-pc.png` | `bg_shines_sp/_pc.png` | 闪点（两张长宽比完全不同） |
| `cloud-back-{l,c,r}.png` | `bg_cloud_back_*.png` | 三片远云：白体换夜蓝，暖色描边保留 |
| `cloud-front-{l,c,r}.png` | `bg_cloud_front_*.png` | 三片近云，同上 |
| `rainbow-bottom-sp.png` / `-pc.png` | `bg_rainbow_btm_sp/_pc.png` | 彩虹两端那两片云（PC 版底边淡出） |
| `rainbow-back-sp.png` | `bg_rainbow_back_sp.png` | 彩虹后面那片云（官方只有一张，两端淡出） |
| `rainbow-sp.png` / `rainbow-pc.png` | `bg_rainbow_sp/_pc.png` | 月虹（降饱和） |
| `aurora-sp.png` / `aurora-pc.png` | `bg_aurora_sp/_pc.png` | 曙光，1:1 重上色，两端各淡 4% |

`MANIFEST.txt` 记录每个文件的字节数与 MD5，跟 `vendor/maimai/img/MANIFEST.txt` 同一个格式。