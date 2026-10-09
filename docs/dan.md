# 随机抽题与段位認定

「随机抽题」把选题的权力从用户手里拿走：服务端抽一道，一开始只告诉你**难度**，点「开始做题」才揭题并起计时。照舞萌 DX 的随机段位認定做的挑战模式则是「做完一道立刻再抽一道，一共三道」。

先说完边界：**这是自测，不是防作弊。** 它唯一能保证的是你没法挑题。详见[「自测，不是防作弊」](#自测不是防作弊)。

## 档位

四个档位按 Codeforces 官方难度（rating）划分，覆盖 800–2600：

| 档位 | 区间 | 单题限时 |
| --- | --- | --- |
| 初级 | 800–1100 | 30 分钟 |
| 中级 | 1200–1500 | 40 分钟 |
| 上级 | 1600–2000 | 50 分钟 |
| 超上级 | 2100–2600 | 60 分钟 |

区间互不重叠，并集正好覆盖 800–2600（相邻区间之间没有空隙，`tests/dan.test.ts` 里有断言）。限时随难度递增。

「每日一题」不分档位，从四个区间的**并集**（800–2600）里抽，限时 45 分钟。

上限为什么卡在 2600：DX Rating 的 T97 曲线在 2000 以上属于外推区（`productionReady: false`，见 [dx-rating.md](dx-rating.md)）。再往上题目数量也少得没法按 rating 均匀抽。

## 抽题口径

### 按 rating 均匀，不按题目均匀

题库里各 rating 的题目数量分布极不均匀：800–899 有 1104 道，900–999 只有 354 道，再往上大致每 100 分 450–540 道。如果直接对题目集合随机挑一道，「初级」会几乎全是 800 分。

所以抽题分两步：**先在区间内的 rating 值之间均匀选一个，再在该 rating 的题目里随机选一道**（`drawDanCandidate`）。这样每一档的难度分布是均匀的，与每个 rating 桶里有多少题无关。

### 排除做过的题

抽题前会剔除本机已经同步到的提交记录里出现过的题 —— 包括**只有 WA、没有 AC** 的。依据是本机数据库里的提交记录，所以同步不完整时可能仍有漏网的，这一点在页面上也写明了。

### 每日一题可复现

每日一题用 `(日期, 用户)` 做种子确定性抽取：同一天怎么刷新都是同一道，换一天才换题。随机抽题与挑战模式用 `crypto.randomInt`，服务端抽、服务端存。

## 口径 A：开始做题之前，链接不下发

**未开始的题目，题号与链接根本不会离开服务端。** 这不是「发到前端再藏起来」，而是服务端在组装响应时就不给：

- `GET /api/dan` 与抽题响应里，未 claim 的 stage 只含 `difficulty`，`problemId` / `problemUrl` 都是 `null`（`src/dx/dan.ts` 的 `danStageView`：只有 `claimed_at !== null` 才填）。
- 唯一的出口是 `POST /api/dan/claim`，它同时做三件事：起计时器（`practice_timers`）、写 `claimed_at`、把 `problemId` 与 `url` 返回给你。前端拿到之后立刻 `location.href` 跳走。

因此**右键、F12、查看网络请求、刷新页面都拿不到** —— 那道题的链接在那个时刻还不存在于任何下发数据里。

这条口径也意味着刻意**不做**这些东西：

- 不屏蔽右键与 F12（屏蔽不掉，而且会干扰正常使用；拦不住的东西不该写成注释里的「保护」）。
- 不做前端混淆或把链接藏在 base64 里（同样是「发下去了」，只是难看）。

`tests/dan.test.ts` 里有一条断言直接搜序列化后的响应体：claim 之前不得出现 `codeforces.com`，也不得出现任何 `contest:index` 形态的题号。API 层另有一条断言覆盖 `GET /api/dan`。

## 挑战模式（段位認定）

一轮挑战是 3 道题、逐题限时：

```
active ──三道全部通关──→ cleared（通过）
   │
   ├──任一道超过限时──→ failed（未通过），本轮立即结束
   └──用户主动放弃──→ abandoned
```

- 第 N 道通关（后台同步发现 AC）后，服务端结算该题，下一道的抽取由 `POST /api/dan/next` 触发。
- 任一道超过限时即判为**本轮失败并结束**，不会继续抽第 N+1 道。
- 一个用户同时只能有一轮进行中的认定（应用层检查 + 数据库上的 partial unique index `one_active_dan_per_user`）。
- 抽了不点也会到期作废（默认 24 小时），不会把唯一的活动轮次永久占住。

### 不发段位名

挑战模式**不给段位名**，结算只展示各题结果与总分（三道单题 rating 之和）以及通过／未通过。

这是照舞萌 DX 的规则定的：随机段位認定本来就不给段位名，给段位名的是**固定选曲段**。所以这里也没有分数段／等级线（AAA、S 之类）—— 只有每题自己的达成率与评级。

### 路径失败也算失败

- 某题超时 → 本轮 `failed`。
- 结算时该题按实际用时正常计分（超时那一刻计时器被释放，时间是真实的），但**本轮**已经判为失败。

## 成绩的去向

挑战与随机抽题的成绩**不是另一套计分**：走的就是正常的计时练习那条链。

- 起计时 → `practice_timers`；AC 被同步到 → 生成 `practice` 记录（`timing_source` 在库里存 `manual`，读取时因为存在对应计时器而被 `listPractice` 报成 `timer`）。
- 因此这些记录**正常进入 B50 与 DX Rating**，可以在 [DX Rating](dx-rating.md) 页面看到。

## 自测，不是防作弊

开始做题之后，你照样可以看题解、问 AI、查博客 —— 这一点拦不住。它和「辅助解题」自报标签是同一条现实：**本地优先的工具只能记录你的自述，不能证明你的清白。**

这个功能能保证的只有一件事：**你没法挑题。** 抽到什么做什么。

另外，「排除做过的题」依赖本机已同步的提交记录；同步不完整时可能抽到你已经做过的题（包括已经 AC 过的）。

## 数据

迁移 `018-dan.sql`，两张表：

- `dan_sessions`：一轮认定（`tier`、`kind` ∈ `challenge` / `single` / `daily`、`stage_count`、`limit_seconds`、`min_rating` / `max_rating`、`status` ∈ `active` / `cleared` / `failed` / `abandoned`、起止时间、`total_rating`、结算快照 `settlement_json`）。
- `dan_stages`：一道题（`session_id`、`stage_index`、`problem_id`、`difficulty`、`drawn_at`、`claimed_at`、`timer_id`、`outcome` ∈ `cleared` / `timeout` / `interrupted`、`seconds`、`score_json`）。

两个设计点：

- **难度在抽题时快照进 `dan_stages.difficulty`**，结算时不重新查题库。否则等题库缓存过期或题目 rating 被 CF 修订，历史记录会跟着变。
- **`settlement_json` 在结束时冻结**整轮结果，记录页读的是快照，不是重新算一遍。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dan?user=&tz=` | 抽题面板与记录页。档位表、题库是否就绪、每日一题的**难度**、进行中的一轮、历史记录 |
| POST | `/api/dan/start` | 开一轮：`{userId, kind, tier?, tz?}`。kind 为 `daily` 时忽略 tier |
| POST | `/api/dan/claim` | **唯一一次下发题号与链接**：`{userId, sessionId}`。幂等，重复点击返回同一道题 |
| POST | `/api/dan/next` | 结算已同步到的 AC 并抽下一道：`{userId, tz?}` |
| POST | `/api/dan/abandon` | 放弃进行中的一轮：`{userId, sessionId}` |

四个 POST 都登记在 `src/server/api.ts` 的 `WRITE_ROUTES` 里。`GET /api/dan` 是只读的：它只从 `fetch_cache` 读题库缓存，读连接是 `PRAGMA query_only = ON`，所以冷缓存时如实返回 `poolReady: false`，由前端引导走一次写接口去抓。

错误码：区间里没有没做过的题是 `POOL_EMPTY`（以 `poolEmpty` 标记返回，不静默抽区间外的题）；已有一轮没结束时 `start` 返回 **409** `SESSION_ACTIVE`；其余 `DanError` 一律 400。

## 题库来源

复用 `problemset.problems` 那份 6 小时缓存（`cf:problemset-ratings:v1`），**不新增数据源、不额外请求**。实测全量 11433 道题，其中 11152 道（97.5%）有官方 rating，上限 3500，不含 gym。各档位可用题量：初级 2312、中级 1875、上级 2578、超上级 2576。

缓存过期时 `POST` 那几条路径会触发一次抓取（约 1.5 MB），之后 6 小时内复用。