# 开发与实现参考

[返回项目首页](../README.md)

本文汇总目录、数据模型、统计口径与 API，面向开发和维护。安装与平台配置请参阅首页的文档入口。

## 目录设计

```text
src/
  domain.ts                 平台无关的提交与缓存协议
  db/
    schema.sql              v1 基础 Schema
    migrations/002-sync.sql v2 同步日志、游标、锁与缓存
    migrations/003-account-profile.sql  v3 账号昵称与解析时间
    migrations/004-score.sql            v4 平台原始得分（洛谷部分分）
    migrations/005-problem-time.sql     v5 用户手填的每题完成用时（DX Rating）
    database.ts             数据库初始化、迁移与 Repository SQL 映射
  problem-scope.ts          「一道题」口径的唯一出处（洛谷比赛内编号不计入）
  account-admin.ts          绑定/解绑账号、增删用户的唯一实现（CLI 与面板共用）
  dx/
    curve.ts                T97 曲线（由 study:export-dx 生成，勿手改）
    rating.ts               用时 → 单题 rating / 完成度 / Rank / b35+b15 的唯一实现
    types.ts                DX Rating 的共享类型
  dx-admin.ts               填写/清除完成用时的唯一实现
  credentials.ts            .env 凭据的读取与就地写入
  fetchers/
    base.ts                 BaseFetcher 抽象类与错误类型
    codeforces.ts           Phase 1 兼容接口、标准化
    codeforces-sync.ts      官方 API 分页和历史回补
    leetcode.ts             国际站近期提交 / 中国站近期 AC 与历史回补入口
    leetcode-history.ts     中国站本人登录态历史分页（含失败提交，无源码）
    atcoder.ts              AtCoder Problems 时间分页
    luogu.ts                账号昵称解析、登录态记录列表
    matiji-live.ts          码蹄集登录态用户记录与分页回补
    matiji.ts               码蹄集本地快照导入
    http.ts                 超时、重试、挑战 Cookie 重试、数据库共享限流
    registry.ts             平台注册与本地凭据注入
  sync/
    service.ts              去重入库、同步日志、缓存和进程锁
    scheduler.ts            不重叠的定时同步循环
  cli.ts / commands.ts      命令行入口与操作
  server/
    queries.ts              Dashboard SQL：题目聚合、筛选、统计口径
    api.ts                  /api/* 的读写路由
    sync-job.ts             面板触发的后台同步任务（同一时刻只跑一个，撞车时可跟随）
    server.ts               只绑定回环的静态资源与 JSON 服务，写请求校验同源
public/
  index.html                 面板骨架（含账号管理区）
  app.js                     Feed 渲染、筛选器、折叠、账号管理与同步进度
  dx.html / dx.js            DX Rating 榜（b35 + b15），填写完成用时
  styles.css                 深色主题，无外部字体或 CDN
tests/
  phase1.test.ts             旧接口回归测试
  phase2.test.ts             迁移、适配器、同步和调度测试
  problem-scope.test.ts      题目数量口径（比赛内编号）与 score 的回归测试
  cf-study.test.ts           统计实验的核心口径测试
  dashboard-admin.test.ts    面板写端点、同源校验与后台同步的端到端测试
  dx-rating.test.ts          换算公式、Rank 门槛、b35/b15 分板（按出题日期）与 problem_times / contests 约束
scripts/smoke.ts             公开接口实测
scripts/dashboard-fixture.ts Dashboard 测试夹具（假数据，独立库）
scripts/backup.ts            VACUUM INTO 快照、可选 CSV 导出与 --prune 清理
scripts/cf-study/           统计实验：抓取、历史账本、离线重建、统计与拟合（见 docs/cf-maimai-study.md）
docs/platforms.md            数据边界、凭据配置、导入格式
dashboard.cmd                Windows 一键启动面板（纯 ASCII，双击即用）
.env                         本地数据库路径与平台凭据，已被 Git 忽略
data/                       首次运行生成，本地数据不提交
data/backups/               npm run backup 生成的快照目录
```

## 数据模型

- `users`：一个本地人物。`is_self` 标记自己（最多一个，是主视图与 DX 榜的锚点）；`is_followed`（v7）标记**关注** —— 只决定「出不出在主视图」，不限数量，且与 `is_self` 是两层。详见下文「关注 ≠ 存在」。
- `accounts`：一个人物可绑定多个平台账号。平台与规范化 handle 唯一；当前仅对 Codeforces handle 忽略大小写。`display_name` 保存从平台解析出的公开昵称（洛谷这类用数字 uid 的平台由此变得可辨认），只用于显示，不参与抓取或唯一性判断。
- `submissions`：关联账号，保留每次提交、题目、难度、标签、判题状态、语言和资源用量。同一账号内 submission ID 唯一；重复保存更新判题结果，支持重判。批量保存使用事务，异常全部回滚。
- `submission_feed`：通过账号关联得到 `user_id`，避免在两张表重复维护用户归属。
- `fetch_cache`：按平台、handle 和条数保存抓取结果，TTL 60 秒；失败不缓存。过期数据不读取，同一个键下次成功请求会覆盖旧数据。
- `sync_state` / `sync_runs`：记录最后尝试、最后成功、失败原因、每轮新增数、覆盖信息和历史回补游标；提交写入与游标更新在同一事务中完成。被**跳过**的账号（前置条件未配齐）不写这两张表 —— 没有尝试，就不该留下尝试的痕迹，否则面板会一直挂着一条并非失败的「失败」。
- `response_cache`：同步结果缓存，TTL 60 秒，`--force` 跳过；`sync_lock` 防止同数据库多个同步进程并发，90 秒租约且每 15 秒续租；`request_slots` 在同数据库内协调各域名请求频率。
- `problem_times`（v5）：用户手填的**每题完成用时**，`(user_id, platform, problem_id)` 唯一。与 `submissions.execution_time`（平台给的判题毫秒数）完全是两回事，所以单独一张表，不混用。只存原始秒数，不存换算后的 rating —— 曲线一改（`npm run study:export-dx`）所有读数都得跟着变，落库就会多出一个真相来源。
- `contests`（v6）：`(platform, contest_id)` 主键，存比赛名与**开始时间**，也就是题目的「出题日期」。b35/b15 的分板看它，不看 AC 时间。数据来自 CF 的 `contest.list?gym=false`，同步时按 6 小时 TTL upsert 写入；`problem_id` 的前缀（`339:A` → 339）就是比赛 id。不按 `type` 过滤 —— `contest.list` 的 `type='ICPC'` 并不是「ICPC 赛制」，Div.3 与 Educational 全是它。v8 加了 `duration_seconds`（比赛时长）：判定「比赛内提交」靠它 —— 首页的最快用时只认比赛窗口内的 AC，时长缺失的比赛一律不判，宁可不算也不猜。

- `dan_sessions` / `dan_stages`（v18，v19/v20 各加了一列）：随机抽题与段位認定。一轮认定一行（档位、`kind` ∈ `challenge`/`single`/`daily`、题数、单题限时、rating 区间、状态），每道题一行（**抽题时快照下来的难度与限时**、`claimed_at`、计时器 id、结果）。难度快照进 `dan_stages` 而不是结算时回查题库，否则题库缓存过期或 CF 修订题目 rating 会让历史记录跟着变；`settlement_json` 同样在结束时冻结。v19 给 `dan_stages` 加了 `limit_seconds`：两个随机段位（`small_random` / `big_random`）rating 不分段、抽到的题横跨 800–2600，限时得随题走，NULL 表示沿用 session 的档位统一限时。v20 给 `dan_sessions` 加了 `tags_json`：自定义单题抽题（`tier='custom'`）的标签条件，NULL 表示无条件；难度范围复用本来就有的 `min_rating` / `max_rating`。随机段位沿用 `kind='challenge'`、自定义沿用 `kind='single'`，都靠 `tier` 区分 —— 加 `kind` 值要重建整张表（SQLite 改不了 `CHECK`）。一个用户同时只能有一轮 `active`，由 partial unique index `one_active_dan_per_user` 兜底。题号与链接在 `claimed_at` 之前不写入响应，详见 [随机抽题与段位認定](dan.md)。

时间统一存 UTC Unix 秒；执行时间为毫秒，内存为字节；缺失值为 NULL。删除用户或账号会级联删除相关提交，未来 UI 必须明确告知这一行为。

Schema 以 `PRAGMA user_version` 标记，当前版本由 `src/db/database.ts` 的迁移列表决定。初始化可重复运行；升级通过增量迁移保留记录。`openDatabase()` 在版本高于代码支持时拒绝打开、低于时按顺序补齐；只读面板则要求版本完全一致，并提示所需命令。

## 练习量与鼓励的统计口径

保留 WA/TLE 等尝试，避免只看到 AC 而忽略投入。后续分别展示提交次数、尝试题数、去重 AC 题数和活跃天数。相同平台的题目以 `(platform, problem_id)` 去重，跨平台同题目前无法可靠识别，不宣称全平台唯一题数。

**洛谷的比赛内编号不计入题目数量。** 同一道月赛题在记录列表里会出现两次：比赛期间的临时编号 `T1234567`，和赛后公开的练习编号 `B4521`，两者题名完全相同。按 `problem_id` 聚合会把一道题算两遍（实测多算 13 个 AC 题目：230 而不是 217）。规则是：`T…` 编号**不进**尝试题数、AC 题数、题目卡片统计，但**提交明细与提交次数照常保留** —— 那次比赛提交确实发生过，只是不该被当成一道新题。面板会把「已排除 N 个洛谷比赛内编号」写在对应的统计卡下面，不做静默过滤；这些题目本身仍然出现在动态里，卡片上带「比赛内编号」标记。匹配条件只有一处定义（`src/problem-scope.ts`），且带 `platform = 'luogu'`，其他平台以 `T` 开头的题号不受影响。

**洛谷的原始得分会存下来（v4）。** 洛谷未通过记录的状态码 `14` 只说明「判完了但没拿满分」，不区分 WA、TLE 还是部分分 —— 这类记录实测占一半以上。载荷里本来就带 `score`，所以 v4 把它存进 `submissions.score`，面板在未 AC 卡片上显示「最高 N 分」。两点必须注意：**满分由题目决定，不是固定的 100**（实测有 30、100，也有更大的），所以只报原始分、不折算百分比；**其他平台不给分数，那里保持 `NULL` 而不是 0** —— 用 0 会让「平台不提供」被读成「考了 0 分」。

近期同步仅抓有限窗口，不能当作历史总练习量。`status` 显示本地提交数、去重 AC 题数与覆盖信息；`history_complete` 仅表示遍历完数据源当时可见历史，不是平台完整性的保证。活跃天数在面板中按浏览器时区计算：前端把 `-getTimezoneOffset()` 作为 `tz` 参数传给服务端，服务端再按该偏移换算当地日期，不假设服务器时区。重判可使 AC 计数减少，统计以最新判题结果为准。

## Dashboard 接口

面板没有引入第三方依赖：服务端读写同一份 SQLite，复用 `src/domain.ts` 的类型、`src/fetchers/registry.ts` 的平台清单，以及 `src/account-admin.ts` 里那套与 CLI 共用的写操作。

| 端点 | 说明 |
|---|---|
| `GET /api/meta` | 用户、账号、平台清单、同步状态与覆盖信息；`scope=me\|all` 决定总览数字只算自己还是包含全部关注的人（默认 `all`） |
| `GET /api/stats` | 提交次数、尝试题数、去重 AC 题数、未 AC 题数、活跃天数，并按平台分解；另含 `contest_only`（被排除在题目口径外的洛谷比赛内编号）与 `partial_credit`（有部分分但未 AC 的提交数） |
| `GET /api/feed` | 题目级聚合分页，已 AC 优先；平台可多选，另支持用户、状态、关键词筛选 |
| `GET /api/problem` | 单题全部提交与判题时间线，用于按需展开「尝试 N 次」 |
| `GET /api/sync/status` | 后台同步任务的当前进度与结果 |
| `GET /api/dx` | DX Rating 榜：曲线元信息、旧题 35 格 + 本年度新题 15 格（按**出题日期**分）、待填写清单（含未评定的题，`problemRating` 为 null）、缺出题日期的题数 |
| `POST /api/dx/time` · `POST /api/dx/time/clear` | 填写 / 清除某道题的完成用时（只接受已 AC 的 Codeforces 题） |
| `GET /api/dan` | 抽题面板与记录页：档位表、题库缓存是否就绪、每日一题的**难度**、进行中的一轮、历史记录。只读，冷缓存时返回 `poolReady: false` |
| `POST /api/dan/start` | 开一轮随机抽题 / 挑战 / 每日一题；已有一轮没结束时回 **409 `SESSION_ACTIVE`** |
| `POST /api/dan/claim` | 起计时并**唯一一次**下发题号与链接；幂等，重复点击返回同一道题。未 claim 的题只含难度，见 [dan.md](dan.md#口径-a开始做题之前链接不下发) |
| `POST /api/dan/settle` | **只结算、不抽题**。轮询走这条，所以出了成绩会停在结算页上；抽下一道要用户点「抽选下一题」走 `next` |
| `POST /api/dan/next` | 结算已同步到的 AC 并抽下一道；区间里没题了回 `poolEmpty` |
| `POST /api/dan/abandon` | 放弃进行中的一轮，释放进行中的计时器 |
| `POST /api/accounts` | 绑定账号；可选带凭据，直接写进 `.env`，值不回显 |
| `POST /api/accounts/unbind` | 解绑账号，必须带显式确认；回报连带删掉的提交条数 |
| `POST /api/accounts/replace` | 换绑同一用户的新账号，要求 `confirm: true`，旧账号归档、新账号从空记录开始 |
| `POST /api/accounts/rename` | 同一账号改名，要求 `sameIdentity: true`，**不动任何历史**；回报该账号名下现存提交条数 |
| `POST /api/users` · `POST /api/users/remove` | 新增 / 删除被观察用户，删除会回报连带删掉的账号数 |
| `POST /api/users/follow` | 切换关注标记；自己恒关注，不能取消 |
| `POST /api/sync` | 在服务端后台跑一次同步，中途关页面不影响；同一时刻只允许一个。撞上正在跑的那轮会回 **409 并带上它的 `job.id`** —— 前端（首页和 DX 页共用同一个后台任务）会跟着它跑到完，而不是让人反复点重试 |

题目在服务端按 `(platform, problem_id)` 聚合：卡片上的「尝试 N 次」是该题全部提交数，包含未通过的尝试；AC 卡片的用时/内存/语言取自最后一次通过的那次提交。洛谷的比赛内编号（`T…`）仍在卡片列表里、带「比赛内编号」标记，但不计入题目数量统计，也不折算合并 —— 合并要靠题名猜，做不到可靠。读取类接口一律只接受 GET，参数越界会被夹取或拒绝，静态资源做了路径穿越校验。

**面板里的「账号管理」。** 点右上角「账号管理」展开（也可以用 `?admin=1` 直接打开），能绑账号、解绑、删用户，以及**回补全部历史**。它在服务端复用 `src/account-admin.ts` —— 和 `npm run algo -- account add` 走的是同一套校验，不是第二份实现。开这个口子之后本机服务就不再是纯只读的，所以写请求额外加了两道：

- **只接受同源请求。** 校验 `Host` 必须是回环地址、`Origin` 必须与之一致，两者不符直接 403。挡住的是 DNS rebinding 和「你用浏览器打开某个网页、那网页顺手 POST 到你本地 8787」这类 CSRF —— 攻击面来自浏览器，不是来自本机。
- **凭据依旧只落在 `.env`。** 写进 `.env` 的值不会出现在响应、日志或数据库里；面板上的凭据框不落任何本地存储。同步失败入库存的报错会先过一道脱敏。

写操作和命令行等价：解绑、删用户都会级联删除提交，所以接口要求显式确认，并在响应里回报删了多少条。账号行上的「待配置 · 变量名」徽标读的是**当前环境就绪情况**，不是在读上一次抓取结果 —— 所以填好凭据或快照路径后它会立刻消失，不必先跑一次同步；这类账号同步时被跳过，也不会显示成「上次抓取失败」。

**绑定前一秒会先去平台上探一下。** 打错的 handle 是最常见的一种「绑了个空账号」—— 它不报错、同步也「成功」，只是永远 0 条，等你几天后才发现。所以绑定时会先问平台一句「这个人存在吗」，结果是三态：

| 状态 | 含义 | 行为 |
|---|---|---|
| `found` | 平台明确说有 | 正常绑定 |
| `missing` | 平台**明确说没有**（CF 返回的 `comment` 里带 `not found`、AtCoder 个人主页 404、洛谷报账号不匹配） | **拒绝绑定**，报错 `ACCOUNT_NOT_ON_PLATFORM`，凭据也不会写进 `.env` |
| `unknown` | 探不到：网络不通、被限流、接口返回看不懂 | **一律放行**，只在回执里标一句「未能确认」 |

「探不到就放行」跟本项目一贯的「跳过 ≠ 失败」是同一条规矩：**只有平台明确说没有，才算没有**。力扣中国站刻意不探 —— 它的接口分不清「人不存在」和「隐私设置挡住了」，`unknown` 会退化成谎报 `missing`。命令行加 `--no-probe` 可跳过探测。

**关注 ≠ 存在。** 加进库里的人和「关注的人」是两件事：`is_followed=0` 的人**数据照抓、一条不少**，只是不出在主视图（地址栏加 `?scope=all`，或点筛选区的「范围」档切回来）。之所以不直接删：**删用户会级联删掉全部提交，不可逆**。所以「暂时不想在主视图看到他」就取消关注，别删。迁移到 v7 时，迁移前已经建的人一律默认已关注 —— 迁移不能悄悄改变你眼前的数据集。自己（`is_self`）恒为关注，取消会被拒绝（`SELF_CANNOT_UNFOLLOW`）。

**区分改名与换绑。**「同一账号改名」要求确认身份未变，保留提交与同步进度；洛谷、码蹄集数字 ID 不支持改名。「换绑账号」将旧账号归档，新建同一用户名下的独立账号。旧提交、同步状态和手填用时保留，旧账号退出统计、B50 和自动同步；旧账号独有的用时不会套用到新账号。归档记录目前只能在账号管理中查看数量，没有恢复入口。换绑其他人的账号请先新建用户再绑定。

命令行：
- 同一账号改名：`npm run algo -- account rename <id> <new-handle> --same-identity`
- 换绑：`npm run algo -- account replace <id> <new-handle> --yes`

旧数据库先备份，再运行 `npm run db:init` 升级到当前版本，最后重启 Dashboard。

**同步与页面操作。** 页面打开时可能自动同步，也可手动点击「同步最新数据」。首页同步面向已绑定账号，DX 页面手动同步针对当前用户的 Codeforces 账号；完成后重新读取本地数据并显示结果。历史回补可从账号管理以及题友个人空间中的账号入口发起。筛选、计时、参考表和图片导出等操作各有入口，不等同于同步。

**CF 题的卡片上有「最快用时」。** 口径：比赛窗口（开赛 → 开赛 + 时长）内**最早一次 AC** 距开赛的时长，取**当前范围内**（仅我 / 我和关注的人）最快的那个人，卡片上带名字。赛后再做（practice / virtual）的 AC 不算 —— 没有时长数据的比赛也不算，宁可空着不猜。时长来自 `contest.list` 的 `durationSeconds`（`contests` 表 v8 列）。

前端刻意不在服务端拼 HTML，全部用 `textContent` 写入 DOM，题库标题里的尖括号不会被当成标记解析；页面不加载任何外部字体或 CDN 资源，离线可用。

数据为空，或某项账号「一条都没同步过」/「同步了但未回补完」时，面板会分成两种情况在顶部标注，都不会把空库或部分数据说成总练习量；读到夹具库时用红色提示这是假数据。
