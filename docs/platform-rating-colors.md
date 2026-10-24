# 各平台 rating / 难度 → 颜色的对照与配置提案

[返回项目首页](../README.md)

本文是**调研记录 + 配置提案**，不是已实现的代码。目的是给「新增一个平台」提供可直接粘贴的
断点表，形状与 `public/cf-rating-colors.js` 完全一致（`[阈值, tone, 标签, 区间]`，从高到低，
外加一张 `tone → [主色, 深色]` 表）。

调研时间 2026-10-18。每条结论后面都跟来源链接。**官方来源**指平台自己的文档 / 自己的 CSS /
自己的 API；**二手来源**指第三方主题、浏览器扩展、博客，文中会点名。凡是我没能从一手来源
证实的数字或颜色，一律在 [第 6 节](#6-不确定项诚实清单) 列出，不写成结论。

本轮调研中，`codeforces.com` 的 HTML 页面对本机请求返回 **403**（静态 CSS 可以取，页面不行），
`leetcode.com` 同样 403；因此 CF 的 CSS 颜色、LeetCode 的难度色分别用了「官方 CSS 静态文件」
替代路径（见下文），并在不确定项里标注了替代范围。

---

## 0. 仓库现有形状（对照用）

`public/cf-rating-colors.js` 现有一张表：

```js
const bands = [
  [2400, 'red', '红色', '2400+'],
  [2100, 'orange', '橙色', '2100–2399'],
  [1900, 'violet', '紫色', '1900–2099'],
  [1600, 'blue', '蓝色', '1600–1899'],
  [1400, 'cyan', '青色', '1400–1599'],
  [1200, 'green', '绿色', '1200–1399'],
  [0, 'gray', '灰色', '低于 1200'],
];
```

关键口径：**tone 是唯一色源**，卡片的 `--tc1 / --tc2`、底板、滤镜都从 tone 查
`CF_TONE_COLORS`。所以新增平台的成本 = 一张断点表 + （必要时）几个新 tone。

下面每个平台给两张东西：**数据表**（供人读）和**同形状的代码**（供直接粘贴，集中在第 4 节）。

---

## 1. Codeforces

### 1.1 比赛 rating → 头衔 / 颜色（官方）

颜色与头衔出自官方公告 [The Second Revolution of Colors and Titles](https://codeforces.com/blog/entry/20638)；
**注意那是 2015 年的表，CM / Master 的分界后来动过**，所以边界以 CF 自己的 API 为准。

我用官方 API 拉了当前全部活跃 rated 用户，按 `rank` 分组求 rating 区间：

```
https://codeforces.com/api/user.ratedList?activeOnly=true&includeRetired=false
→ 49384 人（2026-10-18）
legendary grandmaster        n=23    rating 3006..3657
international grandmaster    n=66    rating 2601..2997
grandmaster                  n=131   rating 2400..2599
international master         n=108   rating 2300..2397
master                       n=425   rating 2100..2299
candidate master             n=702   rating 1900..2099
expert                       n=2833  rating 1600..1899
specialist                   n=4269  rating 1400..1599
pupil                        n=6958  rating 1200..1399
newbie                       n=33869 rating -38..1199
```

| rating | 头衔（官方） | 颜色名（官方公告） | tone | 来源 |
| --- | --- | --- | --- | --- |
| 3000+ | Legendary Grandmaster | red（句首字母黑色） | red | [blog/20638](https://codeforces.com/blog/entry/20638) + 上面的 API 区间 |
| 2600–2999 | International Grandmaster | red | red | 同上 |
| 2400–2599 | Grandmaster | red | red | 同上 |
| 2300–2399 | International Master | orange | orange | 同上 |
| 2100–2299 | Master | orange | orange | 同上 |
| 1900–2099 | Candidate Master | violet | violet | 同上 |
| 1600–1899 | Expert | blue | blue | 同上 |
| 1400–1599 | Specialist | cyan | cyan | 同上 |
| 1200–1399 | Pupil | green | green | 同上 |
| <1200 | Newbie | gray | gray | 同上 |

**两处与 2015 年公告不一致，必须按新版理解**：

- 公告写 `2900+` 是 LGM，且 `1900–2199` 是 Candidate Master、`2200–2299` 是 Master。
  当前实际是 **LGM 3000+**、**CM 1900–2099**、**Master 2100+**。本仓库现有的
  `cf-rating-colors.js`（violet 到 2099、orange 从 2100 起）**与当前实际一致**，是对的。
- Legendary Grandmaster 与其它红色档位的视觉区别不是新颜色，而是**句首字母渲染成黑色**
  （CF 的 CSS 里叫 `legendary-user-first-letter`，见 CF 站内讨论
  [blog/94503](https://codeforces.com/blog/entry/94503) 提到的类名）。

**十六进制（不完整，见第 6 节）**：CF 官方页面没有公布十六进制，它的样式表用的是 CSS
关键字。我只拿到一个可点名的二手来源：[GaurangTandon/codeforces-darktheme](https://github.com/GaurangTandon/codeforces-darktheme)
的 README 表格，它把原作颜色与新色并排列出，其中明确写了
**cyan = `#03a89e`**、**green = `#00d700`**（gray / blue / violet / orange / red 只写了颜色名，
没给原值）。我没有拿到 CF 自己的 CSS（`codeforces.com/css/style.css` 取得到，但里面没有
`user-*` 规则；页面 403），所以**其余 hex 一律不写死**。

### 1.2 题目 rating 的刻度和颜色

题目 rating 是官方数字，直接来自 CF 的 problemset API。实测（2026-10-18）：

```
https://codeforces.com/api/problemset.problems
→ 11152 道有 rating 的题；min = 800，max = 3500；
  全部是 100 的整数倍；共 28 个不同取值（800,900,...,3500）
```

也就是说 **CF 题目 rating 是 800–3500、步长 100 的离散刻度**，量纲和 handle rating 一样，
可以直接当「定数」用（`src/dx/rating.ts` 现在就是这么用的）。

**题目 rating 的颜色：官方没有规定。** CF 没有一份文档说明 problemset 里的 rating 该涂什么色；
本仓库现在的做法——把 handle 的七档色界直接套到题目 rating 上——是**社区通行做法**
（例如 [True Codeforces Heatmap](https://codeforces.com/blog/entry/140881) 这类扩展自己另定了
更细的题目 rating 色带）。我无法确认 problemset 页面的 rating 文本本身是否着色（页面 403）。
**建议：沿用现有 handle 色界，并在注释里说明这是社区约定、不是 CF 官方规定。**

---

## 2. AtCoder

### 2.1 比赛 rating → 颜色（官方，含官方 hex）

AtCoder 官方公告 [AtCoder Rating System](https://atcoder.jp/posts/16) 给出色带；官方样式表
[`img.atcoder.jp/public/5b4b344/css/base.css`](https://img.atcoder.jp/public/5b4b344/css/base.css)
给出精确 hex（我直接抓了这个文件）：

| rating | 颜色名 | tone | 官方 hex | 来源 |
| --- | --- | --- | --- | --- |
| 2800–3199 | Red | red | `#FF0000` | 官方 CSS `.user-red` |
| 2400–2799 | Orange | orange | `#FF8000` | 官方 CSS `.user-orange` |
| 2000–2399 | Yellow | yellow | `#C0C000` | 官方 CSS `.user-yellow` |
| 1600–1999 | Blue | blue | `#0000FF` | 官方 CSS `.user-blue` |
| 1200–1599 | Cyan | cyan | `#00C0C0` | 官方 CSS `.user-cyan` |
| 800–1199 | Green | green | `#008000` | 官方 CSS `.user-green` |
| 400–799 | Brown | brown | `#804000` | 官方 CSS `.user-brown` |
| 0–399 | Gray | gray | `#808080` | 官方 CSS `.user-gray` |
| （未 rated） | — | unrated | `#000000` | 官方 CSS `.user-unrated` |
| （admin） | — | （不用） | `#C000C0` | 官方 CSS `.user-admin` |

**3200 以上没有官方颜色。** 官方公告里 `3200-3599` 与 `3600-3999` 两行写的就是 `???`；官方 CSS
里最高的用户颜色类就是 `.user-red`，没有更高档。**所以 3200+ 只能落回 red，不能自己造一档。**

AtCoder 没有「头衔」这种东西，只有颜色 + rating 数字；用户页显示的是 rating 本身。

### 2.2 AtCoder 自己的题目难度：不存在

AtCoder **不发布题目难度**。比赛页面给的是**配点**（100 / 200 / 300 / …，ABC 的 A–G），
配点不等于难度（同一场里 E 有时比 F 难）。所以「AtCoder 官方题目难度色」这个东西是没有的，
不要假装有。

题目难度的**事实标准**是第三方 AtCoder Problems（kenkoooo）算的 `difficulty`：

- 数值来自 [AtCoder Problems API](https://github.com/kenkoooo/AtCoderProblems/blob/main/doc/api.md)
  的 `problem-models.json` / `merged-problems.json`，是社区用解题者 rating 拟合出来的，
  **不是 AtCoder 官方数据**。
- 颜色分档我从它发布的打包文件里读出来了（这两条是它的原样实现，不是我推的）：
  - [`main.40f7eac8.chunk.css`](https://kenkoooo.com/atcoder/static/css/main.40f7eac8.chunk.css)：
    `.difficulty-red{color:red}`、`.difficulty-orange{color:#ff8000}`、
    `.difficulty-yellow{color:#c0c000}`、`.difficulty-blue{color:#00f}`、
    `.difficulty-cyan{color:#00c0c0}`、`.difficulty-green{color:green}`、
    `.difficulty-brown{color:#804000}`、`.difficulty-grey{color:grey}`
    （dark 主题另有一套浅化值，如 `#ff6767 / #ffb836 / …`）。
  - [`main.11188a2c.chunk.js`](https://kenkoooo.com/atcoder/static/js/main.11188a2c.chunk.js)：
    ```js
    de = ["Black","Grey","Brown","Green","Cyan","Blue","Yellow","Orange","Red"];
    je = e => de[Math.min(Math.floor(e/400), de.length-2) + 1];
    ```
    即 **步长恰恰是 400，颜色顺序与 AtCoder 用户色完全一致**：

| difficulty | tone | light 主题 hex（AtCoder Problems） |
| --- | --- | --- |
| 2800+ | red | `red`（= `#FF0000`） |
| 2400–2799 | orange | `#ff8000` |
| 2000–2399 | yellow | `#c0c000` |
| 1600–1999 | blue | `#0000ff` |
| 1200–1599 | cyan | `#00c0c0` |
| 800–1199 | green | `green`（= `#008000`） |
| 400–799 | brown | `#804000` |
| 0–399 | grey | `grey`（= `#808080`） |

**一个实现细节值得注意**：它的颜色数组里第一个元素是 `"Black"`，但 `+1` 之后
`Black` 永远取不到（`floor(d/400)` 最小是 0，取 `de[1]`）。所以**数值色带里没有黑色档**，
`difficulty-black` 这个类名在 CSS 里也没有配色规则。不要照抄一个「黑色难度档」出来。

---

## 3. LeetCode

### 3.1 比赛 rating 的档位：**百分位制，不是固定分数线**（官方）

官方帖 [🎖 The new contest badge is here! 🎖](https://leetcode.com/discuss/post/934706/the-new-contest-badge-is-here-by-leetcod-34lb)
（由官方账号 LeetCode 发布）原文：

> **Among LeetCoders with rating >=1600**,
> If you are in the top **5%** of the contest rating, you'll get the "**Guardian**" badge.
> If you are in the top **25%** of the contest rating, you'll get the "**Knight**" badge.

所以：

- **没有任何官方数字门槛。** 分数线随参赛人群漂移；「Knight ≈ 1600」「Guardian ≈ 2200」
  是社区对某个时刻百分位的快照，**不是官方边界**（Reddit 上关于「Knight 到底多少分」的
  反复提问本身就是它不固定的证据）。
- 档位名只有两个：**Knight**、**Guardian**，其余人无 badge。没有「专家 / 大师」之类的细分。
- **颜色**：badge 是图片，不是色带。我下载了官方 badge 资产
  （`https://leetcode.com/static/images/badges/guardian.png`、`knight.png`）并采样主色，
  得到的是深灰 / 近黑（`#2F302E`、`#262626` 一类），**不构成可用的颜色阶梯**。官方没有
  公布过 Guardian / Knight 的十六进制配色。
  **结论：不要从官方来源给 tier 绑颜色。** 若要显示，只能自己定（见第 4 节的提案，已注明是自定）。

### 3.2 题目难度 Easy / Medium / Hard：**分类变量，且官方 hex 有据可查**

难度是三个字符串枚举（GraphQL 里就是 `EASY` / `MEDIUM` / `HARD`），**没有数字**。

颜色我拿到了**官方自己的 CSS**（LeetCode 设计系统的 token）。`leetcode.com` 对本机 403，
但**力扣中国站与 LeetCode 共用同一套设计系统**，它的构建产物可以取：

- [`static.leetcode.cn/.../17fab917895643c3.css`](https://static.leetcode.cn/cn-frontendx-assets/production/_next/static/css/17fab917895643c3.css)
  里定义：
  ```css
  --difficulty-easy:   var(--light-teal-60);    /* dark: var(--dark-teal-60) */
  --difficulty-medium: var(--light-yellow-60);  /* dark: var(--dark-yellow-60) */
  --difficulty-hard:   var(--light-red-60);     /* dark: var(--dark-red-60) */
  ```
  同文件里的对应色值：

| 难度 | dark/light token | 浅色主题 hex | 深色主题 hex |
| --- | --- | --- | --- |
| Easy | teal-60 | `#1cb8b8` | `#46c6c2` |
| Medium | yellow-60 | `#ffb800` | `#fac31d` |
| Hard | red-60 | `#f63636` | `#f8615c` |

- **旧版调色板**（长期被各种扩展和文章引用）：Easy `#00b8a3`、Medium `#ffc01e`、
  Hard `#ff375f`。这组值仍是**二手来源**（例如 xbar 插件
  [`leetcode_reminder.5m.py`](https://github.com/matryer/xbar-plugins/blob/main/Web/leetcode_reminder.5m.py)
  里的 `color_easy/medium/hard`）。旁证：`#ffc01e` 确实还留在上面的官方 CSS 里（作为
  `dark-yellow` 旧 token），说明新旧两套并存。

**建议**：主色取官方 CSS 的新 token（`#1cb8b8 / #ffb800 / #f63636`），并在注释里注明旧值
`#00b8a3 / #ffc01e / #ff375f` 是历史版本。

---

## 4. 洛谷（Luogu）

### 4.1 题目难度：**8 档有序枚举 + 官方 hex**（注意：2026-07 起已不是 7 档）

洛谷站务版官方帖 [新版难度体系更新下的临时难度定义](https://www.luogu.com.cn/discuss/1312513)
（2026-07-02，作者 chen_zhe）给出**八档**，颜色直接写在正文的 LaTeX `\color{}` 里：

| 难度码 | 名称 | 颜色 | 官方 hex | 国际站名 |
| --- | --- | --- | --- | --- |
| 1 | 入门 | 红 | `#FE4C61` | Red |
| 2 | 普及- | 橙 | `#F39C11` | Orange |
| 3 | 普及 | 黄 | `#FFC116` | Yellow |
| 4 | 普及+/提高- | 绿 | `#53C41A` | Green |
| 5 | 提高 | **青** | `#13C2C2` | Cyan |
| 6 | 提高+/省选- | 蓝 | `#3498DB` | Blue |
| 7 | 省选/NOI- | 紫 | `#9C3DCF` | Purple |
| 8 | NOI/NOI+/CTS | **黑** | `#0E1D69` | Black |
| 0 | 暂无评定 | — | — | — |

**两个重要偏差，实现前必须知道：**

1. **档数变了。** 老体系是 7 档（入门 / 普及- / 普及·提高- / 普及+·提高 / 提高+·省选- /
   省选·NOI- / NOI·NOI+·CTSC）。新体系插进了 **`提高` 这一档（青色 `#13C2C2`）**，
   共 8 档。任务书里给的 7 档列表、以及 `src/dx/rating.ts` 注释里的
   「洛谷只提供等级码（0–4）」，都是**过时**的说法。帖子自称「临时」，后续可能再动。
2. **官方 hex 与社区表有两个字符级差异**：官方帖是 `#53C41A` 与 `#9C3DCF`；社区整理的
   [洛谷相关颜色参考表（2025-7 版）](https://www.luogu.com/article/uqkvrysw) 写的是
   `#52C41A` 与 `#9D3DCF`。**以官方帖为准**，社区值只作为可能的渲染差异记录。

**难度码是实时可验证的**：洛谷题页的 `lentille-context` 里有 `difficulty` 字段，
2026-10-18 实测 —— P1001 `difficulty=1`、P3373 `difficulty=4`、P1080 `difficulty=5`、
P5659 `difficulty=8`。与上表逐项吻合，说明**新 8 档已经在线上生效**。这也反驳了仓库注释里的
「0–4」。

### 4.2 洛谷比赛等级分（Elo）：**有数字，但没有官方颜色阶梯**

官方帮助中心 [洛谷比赛等级分](https://help.luogu.com.cn/manual/luogu/account/elo-ranking)
说明：洛谷引入了类似 AtCoder 的 Elo 等级分，显示在用户页；全站前 1000 名有榜单
（<https://www.luogu.com.cn/ranking/elo>）。官方还给出各难度比赛的**封顶阈值**：

- Div.4 级比赛：1200
- Div.3 级比赛：1600
- Div.2 级比赛：2000
- Div.1 级比赛：不限

**但官方没有规定等级分的颜色分档。** 所以洛谷的「比赛 rating」是一个**纯数字**，
tone 只能自己定（见第 4 节提案，会标明是自定），不能宣称是洛谷的官方配色。

---

## 5. 其它平台

### 5.1 CodeChef —— 星级（官方）+ 题目难度分档（官方）

**星级**出自官方博客 [Understanding CodeChef's Rating System](https://www.codechef.com/blogs/how-does-codechef-rating-system-work)；
精确区间与徽章底色取自**官方 CDN 上的星带图**（`https://cdn.codechef.com/images/blogs/star-rating-bands.png`，
我下载后用 Pillow 采样七个徽章主色，徽章有轻微渐变，取的是最高频像素）：

| rating | 星 | 徽章底色（采样） |
| --- | --- | --- |
| ≤1399 | 1★ | `#666666` |
| 1400–1599 | 2★ | `#3D7B30` |
| 1600–1799 | 3★ | `#4066C5` |
| 1800–1999 | 4★ | `#634470` |
| 2000–2199 | 5★ | `#F5C142` |
| 2200–2499 | 6★ | `#EF8633` |
| ≥2500 | 7★ | `#BF2828` |

同一篇官方博客给的**division** 是：Div.4 `0–1399`、Div.3 `1400–1599`、Div.2 `1600–1999`、
Div.1 `2000+`。注意 division 与星**不是一回事**：Div.2 横跨 3★ 和 4★。

**题目难度**是数字（题面 URL 里直接带，例如
[`.../course/logical-problems/DIFF800/problems/TODOLIST`](https://www.codechef.com/practice/course/logical-problems/DIFF800/problems/TODOLIST)），
官方练习页按区间分类（[codechef.com/practice](https://www.codechef.com/practice)）：

| 区间 | 官方页面的说法 |
| --- | --- |
| 0–500 | 500 difficulty rating（最基础） |
| 500–1000 | 500 to 1000 |
| 1000–1400 | 帮到 1 star |
| 1400–1600 | 帮到 2 star |
| 1600–1800 | 帮到 3 star |
| 1800–2000 | 帮到 4 star |
| 2000–2500 | 帮到 5 star 及以上 |

**CodeChef 题目难度的官方配色我没能证实**：他们的练习页是客户端渲染，做题页的难度标签
颜色没有落到我可取的一手文件里。第 4 节的提案里，CodeChef 题目难度色是**我按星级色近似的
自定映射**，不是官方值。

### 5.2 TopCoder —— 唯一一个「官方把色阶画成图」的平台

官方文章 [Ratings](https://www.topcoder.com/thrive/articles/Ratings) 正文：
"A coder's handle is color-coded depending on their rating within the Arena."，
并附 "Rating Key" 图。我下载了那张图（`assets.topcoder.com/.../Key-....jpg`）并读了内容：

| rating | 颜色 |
| --- | --- |
| 2200+ | red |
| 1500–2199 | yellow |
| 1200–1499 | blue |
| 900–1199 | green |
| 0–899 | grey |

TopCoder 的**题目**没有 rating 刻度，只有 division 与 problem level（I / II / III），
不构成颜色阶梯。

### 5.3 HackerRank —— 分类难度，没有 rating 色阶

题目难度是 `Easy` / `Medium` / `Hard` 三个字符串（部分 track 另有 `Advanced` 子标签），
例如官方题目页 [hackerrank.com/interview/hackerrank](https://www.hackerrank.com/interview/hackerrank)
列出的 "Easy / Hard" 标签。**没有找到官方把难度或 contest rating 绑到颜色的规则**：
其 Skills 体系用的是星级与奖牌（[hackerrank.com/scoring](https://www.hackerrank.com/scoring)），
与题目难度是两套东西。

### 5.4 CSES —— 完全没有难度

[CSES Problem Set](https://cses.fi/problemset/) 只有分类（Introductory / Sorting and Searching /
Dynamic Programming / Graph Algorithms / Range Queries / Tree Algorithms / Mathematics /
Geometry / String Algorithms …），**没有任何难度数值或颜色**。不要给它造一档。

### 5.5 牛客（Nowcoder）—— 本仓库已确认「不提供难度」

本仓库自己的适配器文档 [docs/platforms.md](platforms.md) 明确写了两件事：
「保留提交结果、得分、语言、运行时间（ms）和内存（KB）」以及「**不提供难度**，不参与 B50」。
牛客的出题规范帖（[牛客系列赛出题难度要求](https://www.nowcoder.com/discuss/1222899)）是用
**CF div2 的 rating 段**（800–900、800–1400 …）来描述题目难度的，这反过来说明牛客**自身没有
题目难度刻度**。该帖是 JS 渲染页，我只读到标题与检索摘要，未能读全文（见第 6 节）。
**结论：牛客没有可绑的颜色维度。**

### 5.6 Virtual Judge —— 聚合器，没有自己的刻度

VJudge 是**提交聚合器**，题目来自各源 OJ，它自己既没有 contest rating 也没有题目难度色阶；
难度信息只在借用源站元数据时出现（例如它的某个训练赛页面写 "a collection of 800-rated
problems from Codeforces"，见 [vjudge.net/contest/750384](https://vjudge.net/contest/750384)）。
做题列表页 [vjudge.net/problem](https://vjudge.net/problem) 需要登录，我未登录看不到难度列。
**建议**：VJudge 上的题按 source judge 走对应平台表，不要给 VJudge 建独立表。

---

## 6. 不确定项（诚实清单）

以下每一条都是**我没能从一手来源证实**的，实现时不要当成事实：

1. **CF 的十六进制颜色**。官方只给颜色名。`cyan = #03a89e`、`green = #00d700` 来自二手来源
   [codeforces-darktheme](https://github.com/GaurangTandon/codeforces-darktheme)；
   gray / blue / violet / orange / red 的 hex 我**没有**可点名来源，故不写。
   （2026-10-18 `codeforces.com` 页面请求 403，拿不到 CF 自己的 `user-*` CSS。）
2. **CF 题目 rating 是否在 problemset 页面着色**。未证实（同样因 403）。本仓库把它按 handle
   色界着色是社区约定，不是 CF 官方规定。
3. **CF 2015 公告与当前边界的差异**。公告（2900+ LGM、CM 到 2199）已被现行实践取代；
   我确认的是**当前 API 的实际区间**，没有找到一份官方公告写明「LGM 改为 3000」。上表按 API
   实测写。
4. **AtCoder 3200+ 的颜色**。官方公告写 `???`，官方 CSS 最高只到 `.user-red`。我用 red，
   但**官方并未定义** 3200/3600 两档的显示方式。
5. **AtCoder 题目难度**。官方没有这东西；`difficulty` 全部来自第三方 AtCoder Problems，
   会随其算法/数据更新而变，且第三方镜像可能缺题。
6. **AtCoder Problems 的 dark 主题配色与 light 不同**（例如 red 在 dark 下是 `#ff6767`）。
   上表给的是 light 值；本仓库是深色卡面的话要另取 dark 值。
7. **LeetCode 的 Guardian / Knight 没有官方分数线**，只有百分位规则。任何「1600 / 2200」
   都是社区快照。另外「top 5% / 25%」的分母是**活跃参赛者**，官方没有公开活跃人数
   （见该帖下的官方回复与用户讨论）。
8. **LeetCode 的难度色取自力扣中国站（leetcode.cn）的 CSS bundle**，因为 `leetcode.com`
   对本机 403。两者共用设计系统，但我**没有**在 `leetcode.com` 自己的 bundle 上复核。
9. **LeetCode Guardian / Knight 的官方配色不存在**，badge 是图片；第 7 节给的颜色是我自定。
10. **洛谷新难度体系被称为「临时」**（帖子原文自述），档数与颜色可能再变；官方 hex 与社区
    整理的 hex 存在 `53C41A vs 52C41A`、`9C3DCF vs 9D3DCF` 的差异。
11. **洛谷比赛等级分没有官方颜色分档**；只有封顶阈值（Div.4/3/2 = 1200/1600/2000）。
12. **CodeChef 题目难度的官方配色未证实**；星带图的 hex 是我从官方 PNG 采样的
    （渐变 + 抗锯齿会带来 ±1~2 的误差），不是官方 token。
13. **牛客出题规范帖未读全文**（JS 渲染），只有标题与检索摘要。
14. **VJudge 登录后的题目列表未看**，结论「没有自己的刻度」基于其聚合器定位与公开页面，
    不是穷尽验证。
15. **HackerRank 是否存在我没找到的颜色规则**：我只确认了「没找到」，不等于「不存在」。

---

## 7. 配置提案（同形，可直接粘贴）

设计原则：

- **tone 名字沿用 `CF_TONE_COLORS` 的词汇**，缺什么补什么（`brown / yellow / black / teal /
  amber / rose`）——新增平台不该改动已有 tone 的观感。
- **表形状与 `cf-rating-colors.js` 完全一致**：`[阈值, tone, 标签, 区间]`，从高到低。
- **映射不干净的地方如实建模**：分类用字符串 key，有序枚举用平台自己的码，
  百分位档位带 `approximate` 标记，绝不把非数值的东西塞进数字阈值。

### 7.1 新增 tone 的配色

共享 tone（`red/orange/violet/blue/cyan/green/gray/unrated`）**继续用仓库现有的
`CF_TONE_COLORS`，不要动**，否则所有已上线的卡片会跟着变色。只补下面这些新 tone：

```js
// 与 CF_TONE_COLORS 合并使用；[主色, 深色]。
// 主色：brown/yellow 取 AtCoder 官方 CSS 值，black 取洛谷官方值，
//       teal/amber/rose 取 LeetCode 官方 CSS 值。深色是本文档按现有表的明度关系生成的，
//       不是任何平台的官方值 —— 如需更贴近 maimai 观感可整体柔化。
export const EXTRA_TONE_COLORS = {
  brown: ['#804000', '#4a2600'], // AtCoder 官方 .user-brown
  yellow: ['#c0c000', '#6f6f00'], // AtCoder 官方 .user-yellow
  black: ['#0e1d69', '#060d33'], // 洛谷 NOI/NOI+/CTS 官方 #0E1D69
  teal: ['#1cb8b8', '#0d6b6b'], // LeetCode 官方 --light-teal-60
  amber: ['#ffb800', '#a67400'], // LeetCode 官方 --light-yellow-60
  rose: ['#f63636', '#a01c1c'], // LeetCode 官方 --light-red-60
};
```

### 7.2 Codeforces

```js
// 与现有 cf-rating-colors.js 的 bands 一致，此处仅为「平台表统一化」后的形态。
// 阈值以 https://codeforces.com/api/user.ratedList 实测为准（2026-10-18）。
export const CF_BANDS = [
  [3000, 'red', 'Legendary Grandmaster', '3000+'],
  [2600, 'red', 'International Grandmaster', '2600–2999'],
  [2400, 'red', 'Grandmaster', '2400–2599'],
  [2300, 'orange', 'International Master', '2300–2399'],
  [2100, 'orange', 'Master', '2100–2299'],
  [1900, 'violet', 'Candidate Master', '1900–2099'],
  [1600, 'blue', 'Expert', '1600–1899'],
  [1400, 'cyan', 'Specialist', '1400–1599'],
  [1200, 'green', 'Pupil', '1200–1399'],
  [0, 'gray', 'Newbie', '低于 1200'],
];
```

**题目 rating 用同一张表**（800–3500、步长 100），只是 label 换成区间文案。
`[2400,'red']` 之下就是 `[2100,'orange']`，与本仓库现状一致。

### 7.3 AtCoder · 比赛 rating

```js
// 阈值与颜色名：https://atcoder.jp/posts/16
// hex 出处：https://img.atcoder.jp/public/5b4b344/css/base.css
// 3200+ 官方只写 "???"，官方 CSS 最高到 .user-red，故落回 red（见第 6 节第 4 条）。
export const ATCODER_BANDS = [
  [2800, 'red', 'Red', '2800+'],
  [2400, 'orange', 'Orange', '2400–2799'],
  [2000, 'yellow', 'Yellow', '2000–2399'],
  [1600, 'blue', 'Blue', '1600–1999'],
  [1200, 'cyan', 'Cyan', '1200–1599'],
  [800, 'green', 'Green', '800–1199'],
  [400, 'brown', 'Brown', '400–799'],
  [0, 'gray', 'Gray', '0–399'],
];
```

### 7.4 AtCoder · 题目难度（AtCoder Problems，第三方）

```js
// 分档逻辑抄自 AtCoder Problems 前端打包文件（步长 400，颜色名与 AtCoder 用户色同序）：
//   de = ["Black","Grey","Brown","Green","Cyan","Blue","Yellow","Orange","Red"]
//   je = e => de[Math.min(Math.floor(e/400), de.length-2) + 1]
// "Black" 在该公式下取不到，故表中没有黑色档 —— 这是它的原样，不要"修好"。
export const ATCODER_PROBLEM_BANDS = [
  [2800, 'red', 'Red', '2800+'],
  [2400, 'orange', 'Orange', '2400–2799'],
  [2000, 'yellow', 'Yellow', '2000–2399'],
  [1600, 'blue', 'Blue', '1600–1999'],
  [1200, 'cyan', 'Cyan', '1200–1599'],
  [800, 'green', 'Green', '800–1199'],
  [400, 'brown', 'Brown', '400–799'],
  [0, 'gray', 'Grey', '0–399'],
];
// 注意：difficulty 是第三方算出来的，不是 AtCoder 官方数据；
// 且 AtCoder 官方给的是"配点"(100/200/300…)，与难度不是一回事。
```

### 7.5 洛谷 · 题目难度（**有序枚举，不是 rating**）

```js
// 洛谷的 difficulty 是 0–8 的有序枚举码，本身就是平台给的值 —— 直接当"阈值"用是诚实的，
// 不存在"编一个数字"的问题。数值区间文案只是展示用。
// 出处：https://www.luogu.com.cn/discuss/1312513 （官方帖，2026-07-02，自称"临时"）
// 线上实测：P1001=1、P3373=4、P1080=5、P5659=8（2026-10-18）
export const LUOGU_DIFFICULTY_BANDS = [
  [8, 'black', 'NOI/NOI+/CTS', 'NOI/NOI+/CTS'],
  [7, 'violet', '省选/NOI-', '省选/NOI-'],
  [6, 'blue', '提高+/省选-', '提高+/省选-'],
  [5, 'cyan', '提高', '提高'],
  [4, 'green', '普及+/提高-', '普及+/提高-'],
  [3, 'yellow', '普及', '普及'],
  [2, 'orange', '普及-', '普及-'],
  [1, 'red', '入门', '入门'],
];
// code 0（暂无评定）→ tone 'unrated'，照 cfRatingColor 的写法在函数里兜底。
```

注意洛谷的「红」是**最低档**（入门），和 CF/AtCoder 把红当最高档**方向相反**。这是平台语义，
不要用同一个「红=强」的假设去渲染。

### 7.6 洛谷 · 比赛等级分（**有数字，无官方颜色**）

```js
// 洛谷只有 Elo 数值，官方没有颜色分档，所以这里没有 bands。
// 若卡片必须给色，建议按官方封顶阈值当"软档位"展示，并标注为自定：
//   Div.4 封顶 1200 / Div.3 封顶 1600 / Div.2 封顶 2000 / Div.1 不限
//   出处：https://help.luogu.com.cn/manual/luogu/account/elo-ranking
export const LUOGU_ELO_DIVISION_CAPS = { div4: 1200, div3: 1600, div2: 2000, div1: null };
```

### 7.7 CodeChef · 星级（比赛 rating）

```js
// 区间来自官方 CDN 图 https://cdn.codechef.com/images/blogs/star-rating-bands.png
// （我下载后逐档采样徽章底色）；division 区间来自官方博客。
export const CODECHEF_STAR_BANDS = [
  [2500, 'red', '7★', '2500+'],
  [2200, 'orange', '6★', '2200–2499'],
  [2000, 'yellow', '5★', '2000–2199'],
  [1800, 'violet', '4★', '1800–1999'],
  [1600, 'blue', '3★', '1600–1799'],
  [1400, 'green', '2★', '1400–1599'],
  [0, 'gray', '1★', '低于 1400'],
];
```

### 7.8 CodeChef · 题目难度（**官方分档，颜色是自定**）

```js
// 区间来自官方练习页 https://www.codechef.com/practice 的分类标题。
// ⚠️ tone 是我按星级色近似的自定映射：CodeChef 题目难度的官方配色未证实（第 6 节第 12 条）。
export const CODECHEF_PROBLEM_BANDS = [
  [2000, 'red', '2000–2500', '5 star+'],
  [1800, 'violet', '1800–2000', '4 star'],
  [1600, 'blue', '1600–1800', '3 star'],
  [1400, 'green', '1400–1600', '2 star'],
  [1000, 'yellow', '1000–1400', '1 star'],
  [500, 'orange', '500–1000', '基础逻辑'],
  [0, 'gray', '0–500', '最基础'],
];
```

### 7.9 LeetCode · 题目难度（**分类变量：不要塞进数字阈值**）

```js
// 难度是字符串枚举 EASY/MEDIUM/HARD，没有数字。用 key 查表，别伪造 rating。
// hex 出自 LeetCode 官方 CSS token：
//   https://static.leetcode.cn/cn-frontendx-assets/production/_next/static/css/17fab917895643c3.css
//   --difficulty-easy: var(--light-teal-60) = #1cb8b8
//   --difficulty-medium: var(--light-yellow-60) = #ffb800
//   --difficulty-hard: var(--light-red-60) = #f63636
// 旧版常用值（#00b8a3 / #ffc01e / #ff375f，二手来源）在注释里留档即可。
export const LEETCODE_PROBLEM_DIFFICULTY = {
  EASY: { tone: 'teal', label: 'Easy', labelZh: '简单' },
  MEDIUM: { tone: 'amber', label: 'Medium', labelZh: '中等' },
  HARD: { tone: 'rose', label: 'Hard', labelZh: '困难' },
};
export function leetcodeDifficultyColor(difficulty) {
  const key = String(difficulty ?? '').toUpperCase();
  return LEETCODE_PROBLEM_DIFFICULTY[key] ?? null; // null = 认不出来，按无档处理
}
```

### 7.10 LeetCode · 比赛档位（**百分位：必须带"近似"标记**）

```js
// 官方规则（https://leetcode.com/discuss/post/934706/...）：
//   "Among LeetCoders with rating >=1600, top 5% => Guardian, top 25% => Knight"
// 没有官方分数线，官方也没有配色（badge 是图片）。所以：
//   - 不给它 bands（那是假的）；
//   - rating 只用来做一个"大概会不会拿到 badge"的提示，且必须带 approximate: true；
//   - tone 是自定（官方无配色）。
export const LEETCODE_CONTEST_TIERS = [
  { key: 'guardian', label: 'Guardian', tone: 'red', basis: 'rating>=1600 的前 5%',
    approximateRatingFloor: 2200, approximate: true },
  { key: 'knight', label: 'Knight', tone: 'violet', basis: 'rating>=1600 的前 25%',
    approximateRatingFloor: 1600, approximate: true },
];
// approximateRatingFloor 是社区对某时刻百分位的快照，会漂移；
// 界面上若用它，应显示成"约 2200+"，不能写成官方门槛。
```

### 7.11 统一查表入口

```js
// 与 cfRatingColor 同构：输入"数值型"的难度/rating，输出 {tone,label,range}。
// 分类型（LeetCode 难度）与档位型（LeetCode badge）不走这里。
export const PLATFORM_BANDS = {
  codeforces: CF_BANDS,
  atcoder: ATCODER_BANDS,
  'atcoder-problems': ATCODER_PROBLEM_BANDS,
  codechef: CODECHEF_STAR_BANDS,
  'codechef-problem': CODECHEF_PROBLEM_BANDS,
  'luogu-difficulty': LUOGU_DIFFICULTY_BANDS, // 注意：key 是洛谷自己的 1–8 难度码
};

export function platformRatingColor(platform, value) {
  const bands = PLATFORM_BANDS[platform];
  if (!bands || !Number.isFinite(value) || value < 0) {
    return { tone: 'unrated', label: '未评级', range: '待定' };
  }
  const [, tone, label, range] = bands.find(([minimum]) => value >= minimum);
  return { tone, label, range };
}
```

---

## 8. 命名（结算卡上的「平台名 + 每题标签」）

每个平台对自己的档位叫法都不一样，卡片文案建议照下表直接取：

| 平台 | 平台名建议 | 这一档叫什么（官方叫法） | 每题标签建议 |
| --- | --- | --- | --- |
| Codeforces | `Codeforces` | 头衔：Newbie / Pupil / Specialist / Expert / Candidate Master / Master / International Master / Grandmaster / International Grandmaster / Legendary Grandmaster | 题目用 `rating`（如 `*1400`），结算用头衔或纯数字 |
| AtCoder | `AtCoder` | 比赛 rating 只有**颜色名**（Gray/Brown/Green/Cyan/Blue/Yellow/Orange/Red），无头衔 | 比赛用颜色名或 rating 数字；题目难度标 `Difficulty`（第三方值） |
| AtCoder Problems | `AtCoder Problems` | 同上颜色名 | `Difficulty 1623`，并注明非官方 |
| LeetCode | `LeetCode` | 比赛档位：**Knight** / **Guardian**（仅两个）；题目难度：**Easy / Medium / Hard** | 题目直接印 `Easy/Medium/Hard`；比赛档位印 `Knight`/`Guardian`，别印自造的头衔 |
| 洛谷 | `洛谷` / `Luogu` | 难度：**入门 / 普及- / 普及 / 普及+/提高- / 提高 / 提高+/省选- / 省选/NOI- / NOI/NOI+/CTS**；比赛分：**比赛等级分** | 题目印难度名（中文）；比赛印 `等级分 1234` |
| CodeChef | `CodeChef` | 比赛：**N★**（1–7 星）+ Division；题目：**difficulty rating** | 比赛印 `4★`；题目印难度分 |
| TopCoder | `TopCoder` | 只有颜色名，无头衔名 | 印 rating 数字 |
| HackerRank | `HackerRank` | 题目难度：**Easy / Medium / Hard**（部分有 Advanced） | 印难度词；无 rating 可印 |
| CSES | `CSES` | 只有分类名（Introductory / Sorting and Searching / …） | 印分类名，**不要印难度** |
| 牛客 | `牛客` | 无难度字段（本仓库已确认） | 不印难度 |
| Virtual Judge | `Virtual Judge`（或标为来源平台） | 无自有档位 | 按 source judge 走对应表 |

两处易错点：

1. **别把 CF 的头衔名搬到别的平台**。AtCoder / TopCoder 只有颜色名，LeetCode 只有
   Knight / Guardian 两个，洛谷只有难度名。凭空造一个「AtCoder Master」是错的。
2. **红色在不同平台含义相反**：CF / AtCoder / CodeChef 里红是最高档；洛谷里红是**最低档**
   （入门）。文案与图例都要跟着平台走。
