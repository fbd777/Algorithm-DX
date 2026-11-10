# AtCoder DX Rating 支持方案（评审稿）

> 状态：方案评审中。本文先确定数据事实与换算口径，再开放到 DX/B50 页面。

## 1. 目标

在现有 AtCoder 提交同步的基础上补齐：

1. 正确题名，不再把 `problem_id` 当题名；
2. 题目发布日期，用于 B35/B15 分区；
3. AtCoder 原生估算难度；
4. 将原生难度映射到现有 Codeforces 题目 Rating 标尺；
5. 让 AtCoder 题复用现有 T97、完成度、单题 Rating 与 B50 计算。

首版不把 AtCoder 和 Codeforces 题直接混在同一个榜里。建议先做平台切换：

- Codeforces B50：保持现状；
- AtCoder B50：使用映射后的 CF 等效难度；
- 混合 B50：等映射经过回测后再开放，避免未经验证的换算直接改变现有总分。

## 2. 数据来源

### 2.1 AtCoder 官方站

AtCoder 官方没有公开的题目 Rating API，也没有官方提交历史 API 供本项目直接使用。

项目只用官方个人页做账号存在性探测：

```text
GET https://atcoder.jp/users/{user_id}
```

- HTTP 200：账号存在；
- HTTP 404：账号不存在；
- 403、503、网络错误：只表示本次无法确认，不能判账号不存在。

### 2.2 AtCoder Problems 第三方 API

主要数据来自开源项目 [kenkoooo/AtCoderProblems](https://github.com/kenkoooo/AtCoderProblems)。
其 [API 文档](https://github.com/kenkoooo/AtCoderProblems/blob/main/doc/api.md) 明确说明这些接口是非官方接口，
并要求请求之间至少间隔一秒。

#### 用户提交记录

```text
GET https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions
    ?user={user_id}
    &from_second={unix_second}
```

一次最多返回指定时间之后的 500 条提交。项目当前已经使用该接口，并按时间游标分页、边界秒重叠、
本地按提交 ID 去重。

使用字段：

```json
{
  "id": 123456,
  "epoch_second": 1700000100,
  "problem_id": "abc001_1",
  "contest_id": "abc001",
  "result": "AC",
  "language": "C++ 23",
  "execution_time": 12
}
```

这个接口没有题名、题目难度和比赛开始时间，因此还需要以下静态资源。

#### 题目清单

```text
GET https://kenkoooo.com/atcoder/resources/problems.json
```

关键字段：

```json
{
  "id": "abc001_1",
  "contest_id": "abc001",
  "problem_index": "A",
  "name": "Visibility",
  "title": "A. Visibility"
}
```

用途：用 `id` 关联提交，补题名和比赛 ID。

#### 比赛清单

```text
GET https://kenkoooo.com/atcoder/resources/contests.json
```

关键字段：

```json
{
  "id": "abc001",
  "start_epoch_second": 1347242400,
  "duration_second": 7200,
  "title": "AtCoder Beginner Contest 001",
  "rate_change": "~ 1199"
}
```

用途：补比赛开始时间，作为题目的发布日期；同时保存比赛时长，为以后支持比赛内自动计时留数据。

#### 题目难度模型

```text
GET https://kenkoooo.com/atcoder/resources/problem-models.json
```

关键字段：

```json
{
  "abc138_d": {
    "difficulty": 920,
    "discrimination": 0.004479398673070138,
    "is_experimental": false,
    "slope": -0.0011986025321558905,
    "intercept": 8.48597477902844,
    "variance": 0.4317652846787837
  }
}
```

`difficulty` 是 AtCoder Problems 根据比赛结果估算的难度，不是 AtCoder 官方值。`is_experimental=true`
表示样本或模型尚不稳定，首版不让这类题进入 B50。

## 3. AtCoder 原生难度处理

`problem-models.json` 中低于 400 的值是模型内部难度。AtCoder Problems 前端显示时会使用以下修正：

```text
displayed = raw                                      raw >= 400
displayed = 400 / exp(1 - raw / 400)                 raw < 400
```

此规则来自 AtCoder Problems 前端的 `clipDifficulty` 实现。项目必须复刻该规则，不能直接把负数或
很低的内部值拿来映射。

例子：

| 模型原值 | AtCoder Problems 显示难度 |
| ---: | ---: |
| -848 | 18 |
| -96 | 116 |
| 0 | 147 |
| 400 | 400 |
| 920 | 920 |

## 4. 映射到 Codeforces Rating

### 4.1 为什么不能直接照搬

AtCoder Problems 难度和 Codeforces 官方题目 Rating 都近似表达“什么水平的选手能解决这道题”，
但两站的选手 Rating 分布、颜色分段、比赛人群与模型不同。`AtCoder 1200 = CF 1200` 没有数据依据。

现有 DX 的 T97 曲线是用 Codeforces 数据拟合的，所以 AtCoder 题进入现有计分前，必须先得到
“CF 等效题目 Rating”。

### 4.2 开源选手 Rating 换算

采用 [SilverFoxxxy Rating Converter 源码](https://github.com/SilverFoxxxy/SilverFoxxxy.github.io/blob/main/converter.js)
中的 AtCoder → Codeforces 换算。作者的
[相关性说明](https://silverfoxxxy.github.io/rating-correlation)称样本来自 4,517 个在 AtCoder 资料中关联了
Codeforces 账号、且两个平台都至少参加 7 场比赛的选手。

源码用两端点做线性插值：AtCoder `-940 → 4215` 对应 Codeforces `0 → 3900`：

```text
cf_player_equivalent = 3900 * (atcoder_displayed + 940) / 5155
cf_equivalent = trunc(cf_player_equivalent)
cf_equivalent = clamp(cf_equivalent, 800, 3500)
```

`trunc` 与原转换器源码一致。本项目不再额外取 100 档：现有 T97 曲线可以对任意整数难度连续
插值，取整到百位只会损失信息。800–3500 裁剪来自现有 T97 曲线的有效范围。

对应锚点：

| AtCoder 显示难度 | CF 等效 Rating |
| ---: | ---: |
| ≤ 100 | 800 |
| 400 | 1013 |
| 800 | 1316 |
| 1200 | 1619 |
| 1600 | 1921 |
| 2000 | 2224 |
| 2400 | 2526 |
| 2800 | 2829 |
| 3200 | 3132 |
| 3600 | 3434 |
| ≥ 3687 | 3500 |

这比原先的经验公式可靠，但仍有两个边界：样本与拟合来自 2021 年的选手 Rating；把选手水平映射
用于题目难度，依赖“AtCoder Problems difficulty 是 50% 解出点附近的选手水平”这一模型语义。
因此页面仍必须写“CF 等效难度”，不能标成“官方 Rating”。

### 4.3 推荐的正式校准方法

正式版本应建立独立研究脚本，输出版本化映射文件：

1. 收集同时有 AtCoder 与 Codeforces 账号的选手样本；
2. 以两站当前 Rating 的分位数做第一层单调映射；
3. 用题目解出概率校验：映射后相同 Rating 差应有接近的解出率；
4. 使用时间切分验证，避免只拟合历史样本；
5. 对低分段、3000 以上高分段单独报告样本数和置信区间；
6. 产出 `v2` 映射，而不是原地修改 `v1`。

如果共同账号样本不足，宁可继续标记为 Beta，也不伪造精度。

## 5. 同步与缓存流程

```text
AtCoder 提交 API
       │ problem_id / contest_id
       ▼
problems.json ── 补题名
       │
       ├── contests.json ── 补发布日期与比赛时长
       │
       └── problem-models.json
                 │ 低分修正
                 │ CF 等效映射 v1
                 ▼
            submissions.difficulty
```

缓存策略：

- 提交 API：沿用现有一分钟响应缓存和同步游标；
- 题目、比赛、难度资源：缓存六小时；
- 请求间隔：同域名至少 1.1 秒；
- 映射版本写进缓存键；升级映射版本时会重新计算并回填已有 AtCoder 提交；
- 辅助元数据抓取失败不能回滚已经成功拉到的提交，但同步记录必须显示失败原因。

## 6. 数据库存储

首版复用现有表，不新增第二套评分真相：

- `submissions.problem_title`：AtCoder 真实题名；
- `submissions.difficulty`：CF 等效难度，用于现有 DX 纯函数；
- `contests.contest_id`：SQLite 可存 AtCoder 字符串比赛 ID；
- `contests.start_time`：发布日期；
- `contests.duration_seconds`：比赛时长。

AtCoder 原生显示难度暂存在题目元数据缓存中。若页面需要同时展示“原生难度 / CF 等效难度”，
再增加正式的 `problem_metadata` 表，不要把两个数都塞进 `submissions.difficulty`。

## 7. 页面与计分接入顺序

### Phase A：数据基础

- 补题名；
- 抓比赛日期；
- 抓难度模型；
- 计算并回填 CF 等效难度；
- 增加数据源、低分修正、实验题与日期关联测试。

### Phase B：AtCoder 独立 B50

- DX 页面增加平台选择；
- AtCoder 与 Codeforces 分开取 B35/B15；
- 填写用时接口接受当前所选平台；
- AtCoder 暂只支持手填用时；现有专注计时器仍只支持 Codeforces；
- 卡片同时标注 `AtCoder 1200 → CF 等效 1619`。

### Phase C：校准与混合榜

- 建立跨平台校准样本与回测报告；
- 发布版本化 v2 映射；
- 确认分数偏差可接受后，再决定是否开放 Codeforces + AtCoder 混合 B50。

## 8. 风险与降级

- AtCoder Problems 是第三方服务：接口不可用时保留已有数据，不清空难度；
- 静态资源可能改字段：结构异常必须明确报错，不能把整批题写成空标题或 800；
- 模型缺失或实验性：允许记录用时，但标记“等待稳定难度”，不计分；
- 映射仍是 Beta：AtCoder 榜必须显示映射版本与第三方来源；
- 映射升级会改变 AtCoder 历史分数，因此版本号和回测报告必须可追踪；
- Codeforces 榜默认行为与现有历史分数不得改变。

## 9. 验收标准

- 同步一条 AtCoder 提交后，题名不再是 `abc001_1`；
- 稳定模型题得到可解释的 CF 等效难度；
- 实验题和无模型题保持未评级；
- AtCoder 比赛字符串 ID 能正确关联发布日期；
- 缓存命中时不重复请求三个大资源；
- 元数据失败不会丢提交；
- Codeforces 全部既有测试保持通过；
- AtCoder B50 上线前，页面明确展示第三方来源、等效难度和映射版本。
