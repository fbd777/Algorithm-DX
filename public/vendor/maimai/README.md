# vendor/maimai —— maimai DX 国际版官网素材（PRiSM PLUS 时期）

前端重构的参照物：`maimai DX International ver.` 官网在 **PRiSM PLUS** 时期的样式与皮肤素材。
这里只放「原样搬过来」的东西；把它落到本站组件上的那一层在 [`public/theme.css`](../../theme.css)。

## 来源

| 文件 | 原始地址 | 快照 |
| --- | --- | --- |
| `style.css` | `https://maimai.sega.com/assets/css/style.css` | `web.archive.org/web/20250804084236` |
| `img/**`（92 个） | `https://maimai.sega.com/assets/img/**` | 同上（线上仍在，直接抓线上） |
| `fonts/**` + `fonts.css` | `https://fonts.googleapis.com/css2?family=M+PLUS+1p:wght@400;500;700;800;900` | 2026-10-10 抓取 |

归档页面本身（`https://web.archive.org/web/20250804084236/https://maimai.sega.com/`）与线上现站
（已更新到 CiRCLE PLUS）**样式表不同**：PRiSM PLUS 版的 `.common--box` 是上紫 `#ba5eea` /
下粉 `#ffcedf`，CiRCLE PLUS 版换成了 `#f93eac` / `#6dbefe`。所以这里以归档快照为准。

## 对原文件做了什么

- `style.css`：只改了 URL。wayback 前缀与 `https://maimai.sega.com/assets/img/` 全部改写成
  `/vendor/maimai/img/`（73 处），Google Fonts 的 `@import` 换成注释（字体改为自托管，
  见 `fonts.css`）。**选择器与数值一个都没动**，要核对官方参数直接在这个文件里查。
- `img/**`：原始字节，未做任何压缩或转码。`img/MANIFEST.txt` 记录每个文件的字节数与 MD5。
- `fonts.css`：只自托管 latin / latin-ext 子集（5 个字重 × 2 子集，共 10 个 woff2）。
  M PLUS 1p 没有简体字，中文由 `theme.css` 里的系统字体栈回退。

## 授权

- `M PLUS 1p` 是 SIL Open Font License 1.1，可自由再分发。
- `style.css` 与 `img/**` 是 **SEGA 的版权素材**，这里作为个人自用项目的样式参照/复刻保留，
  不属于 MIT 授权范围，也不代表 SEGA 授权。若要公开发布，请自行替换或取得许可。