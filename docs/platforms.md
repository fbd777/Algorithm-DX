# 平台接入与数据边界

[返回项目首页](../README.md)

## 接入清单

在页面「账号管理」中选择平台并绑定账号。登录凭据填写自己的，不向题友索取；公开接口不需要额外配置 Cookie。

| 平台 | 账号填写方式 | 首次使用需要准备 |
| --- | --- | --- |
| Codeforces | handle（用户名） | 普通公开记录直接绑定；Group 比赛按专门说明配置 |
| LeetCode 国际站 | 个人主页 username | 直接绑定；只提供近期公开提交 |
| 力扣中国站 | 个人主页 `/u/<slug>/` 中的 slug | 近期 AC 直接绑定；本人历史回补另填 Cookie |
| AtCoder | 用户 ID | 直接绑定；记录来自 AtCoder Problems 镜像 |
| 洛谷 | 数字 UID，不是昵称 | 自己的登录 Cookie：`__client_id` 和 `_uid` |
| 码蹄集 | 本人昵称与主页链接；他人数字 ID 或主页链接 | 首次填自己的 Cookie；本人账号可自动识别 ID |
| 牛客 | 数字用户 ID | 直接绑定；仅公开编程练习记录 |

### 同步能力与限制

- **Codeforces**：近期同步和公开历史回补保留各类判题结果。唯一支持 DX / B50 的平台，计分仍需有效用时、AC 记录与题目评级。Group 比赛需额外配置。
- **LeetCode 国际站**：最多 20 条近期公开提交，不支持完整历史回补。
- **力扣中国站**：公开同步最多 20 条近期 AC。本人 Cookie 可用于回补可见历史，包含失败提交、不读取源码；登录身份必须与绑定账号一致。目前尚未完成真实登录态验证。
- **AtCoder**：支持镜像中近期与历史记录，第三方镜像可能延迟或缺失。
- **洛谷**：需登录态读取可见记录，支持历史回补；隐私或比赛权限限制仍然有效。
- **码蹄集**：需登录态，支持近期记录与可见历史回补，也可备用导入 JSON。已完成真实账号的小样本验证，较大账号跨页仍需更多验证。
- **牛客**：支持公开编程练习记录及历史回补，不包含选择题和非公开记录，也不参与 B50。

**近期同步、历史回补和 DX 计分是不同能力。** 已同步记录可用于本地记录与统计，字段缺失时对应统计维度可能不可用。支持回补不保证覆盖平台全部历史。

## 详细说明

以下为当前适配器的实现范围与验证记录。所有统计都是**已经抓取或导入的记录**，不能默认理解为平台历史总量。`status` 的 `coverage_json` 保存来源、数据范围、是否只有 AC、是否遍历完本次范围、最早和最新记录时间。

需要前置条件的平台（洛谷、码蹄集要 Cookie；码蹄集仍兼容显式本地快照配置）在条件缺失时会被**跳过**，而不是报成失败：不调用适配器、不发请求、不写 `sync_runs` / `sync_state`。跳过不计入成功数，也不影响退出码。只有真的发了请求又挂了才算失败。

## Codeforces · `codeforces`

账号用 handle。使用 [官方 user.status](https://codeforces.com/apiHelp/methods#user.status)，保留全部判题状态，支持近期分页和历史回补。请求至少间隔 2.1 秒。`--backfill` 每页 100 条，默认最多 10 页；下次继续游标。平台使用偏移分页，过程中新增提交可能导致重复或位移；本地去重并重叠一条，仍建议完成后刷新近期记录。

## LeetCode 国际站 · `leetcode`

账号用个人主页 username。使用 [国际站 GraphQL](https://leetcode.com/graphql) 的 `recentSubmissionList`，包含近期公开提交与判题状态；最多请求 20 条。没有完整历史回补。题目难度和资源用量在此接口缺失，保存为空，不填造数值。

## 力扣中国站 · `leetcode-cn`

账号用 `/u/<slug>/` 中的 slug，与国际站分别绑定。普通「同步最新数据」仍使用公开 `recentACSubmissions`，最多 20 条 AC；空列表不证明没有练习。

**历史回补（含失败提交，无源码）：** 在账号管理中选择力扣中国站，填写本人登录 Cookie 并保存，然后点击该账号的「回补历史」。也可以在本机 `.env` 设置 `ALGORITHM_DX_COOKIE_LEETCODE_CN="LEETCODE_SESSION=…; csrftoken=…"`，再运行 `npm run sync -- <账号ID> --backfill --pages 100`。Cookie 不要粘贴到聊天或提交到版本库。

每批首先用 `userStatus` 校验登录状态和 `userSlug`，不匹配立即停止，防止把 Cookie 本人的数据写到其他账号。查询 `/graphql/` 的 `userProgressQuestionList`，分页收集 SOLVED 与 ATTEMPTED；然后逐题分页读 `submissionList`，不筛选状态或语言。只保存提交 ID、题目、时间、语言和判题结果，不请求源码。未知结果保留原值。

`--pages` 限制本批题目列表与提交列表请求的总页数（不含一次身份校验），每页最多 20 条。初始批次可能只收集题目，提交数为 0 仍未完成；继续「回补历史」会从已保存的游标续跑。提交和游标在同一事务中保存，重复提交按 ID 去重；登录失效、接口错误或分页停滞均不推进该批游标。

只有遍历到所有题目末页才标记当前可见历史完成；隐藏、删除或接口不再开放的记录不能保证获取。回补期间新增提交或题目状态变化后，可运行 `npm run sync -- <账号ID> --backfill --force --pages 100` 从头核对，再继续不带 `--force` 的回补直到完成。失败尝试的后续更新也通过回补获取。当前使用模拟 HTTP 验证，尚未以本人真实登录态验证接口。

## AtCoder · `atcoder`

账号用用户 ID。使用 [AtCoder Problems 文档](https://github.com/kenkoooo/AtCoderProblems/blob/main/doc/api.md) 中的 v3 接口。这是第三方镜像，可能有延迟或缺失。默认近期查询从 30 天前开始；`--since` 可指定 UTC 秒数（仅 AtCoder 使用）。单页最多 500 条，按时间升序返回，跨页重叠边界秒并去重；无法安全推进时明确失败，避免跳过记录。

`--backfill` 从时间 0 开始，每次保存游标直到遍历完镜像当前数据。后续定时同步只查近期窗口，旧记录重判可用 `--backfill --force` 重新遍历。达到页数上限时，可能还没查到窗口中的最新提交；日志会说明，不宣称完整。题名暂用 task ID；资源用量仅保存接口提供的执行时间，内存缺失。

## 洛谷 · `luogu`

账号用数字 UID（**不是昵称**，即使昵称看起来像账号名）。2026-09-16 实测：未登录访问 [提交列表](https://www.luogu.com.cn/record/list) 返回 401，而个人主页 `/user/<uid>` 公开可读。添加账号后，把**观测者自己**的登录 Cookie 放在本地 `.env` 的 `ALGORITHM_DX_COOKIE_LUOGU` 中（**按平台一份，不按账号**；旧写法 `ALGORITHM_DX_COOKIE_<本地账号ID>` 仍兼容）。洛谷登录态只需两个键：`__client_id`（真正的凭据，务必保密）与 `_uid`（你自己的数字 uid，公开无妨），不必复制整行 Cookie。Cookie 只发送到洛谷固定域名。无需把 Cookie 发给助手。

**绑定与凭据一步完成。** 不想手工编辑 `.env` 时，可以把凭据交给 `account add --cookie "<值>"`，它会就地更新 `.env`（保留注释与其他行），输出里只回报写进了哪个变量、**不回显凭据本身**。值里含引号或换行会被拒 —— 换行会让它凭空造出一个新变量（例如 `ALGORITHM_DX_DB_PATH`），把「填 Cookie」变成「改写程序配置」。该选项只对需要凭据的平台开放（`luogu`、`matiji`），用在公开接口平台上会直接报错。

账号**已经绑过**时再执行一次也只更新凭据：输出带 `"existing": true`、不重复建账号。唯一会被拒的情况是这个 handle 已绑在别的用户名下（`accounts` 上是 `UNIQUE(platform, handle_key)`，不含 `user_id`，所以必须显式挡住越权接管）。

**观察他人（文档确认，客户端未实测）。** 洛谷记录页自身即为「查找记录」，支持按用户名或 uid 搜索，因此**登录后可以查看他人的记录**。例外是对方开启了「完全隐私保护」，此时对任何用户都不可见，只显示为匿名用户。因此观测多个人的记录只需**一份**自己的 Cookie，**不需要向每个人索要凭据**；未登录时该页一律 401，与目标账号是谁无关。

**挑战 Cookie。** 洛谷对非浏览器客户端先返回 `302`，并在 `Set-Cookie` 里发一个挑战 Cookie（`C3VK`），必须带着它重试才能拿到内容。请求层已支持这条重试链（最多 2 次），并把「挑战失败」与真正的「需要登录」分开报错；此前 `redirect: 'error'` 会把这类响应直接变成 `network request failed`，使洛谷整条路不可用。

**昵称解析（已实测）。** 绑定洛谷账号后会读取 `/user/<uid>` 的 `lentille-context`，解析出 uid、昵称、签名、注册时间并写入 `accounts.display_name`，输出形如 `已识别：某个昵称（uid 1000001）`。这只用于确认绑对了人和界面显示，解析失败仅告警、不阻断绑定，也不参与抓取或唯一性判断。

**记录列表（2026-09-17 已实测跑通）。** `GET /record/list?user=<uid>&page=N` 带登录 Cookie 时返回 `200`，载荷在 `lentille-context` 的 `data.records` 里（不是 `currentData`，代码两处都兼容）；`page` 参数有效，`perPage = 20`，`count` 是提交总条数。实测 653 条 / 240 道题，无空题名、无空题号、无重复 submission_id。页面结构不符会报 `SCHEMA_CHANGED`，不会当作空记录成功同步。

实测字段（**别猜**）：记录的键是 `id / status / enableO2 / score / time / memory(KB) / sourceCodeLength / submitTime / language / user / contest / problem`；`problem` 的键是 `pid / type / name / difficulty / fullScore / submitted / accepted` —— 题名在 **`name`**，**没有 `title`**（按 `title` 取会让整次同步以 `Missing problem title` 失败）。题名解析规则有回归测试兜着，键名不对会直接报错而不是写空标题。

判题状态实测：`2` 编译错误（`score` 为 `null`）、`12` 满分、`14` **未满分**（洛谷叫 "Unaccepted"，`score` 是部分分）。`14` 不映射成 WA —— 判完了但没拿满分，具体是 WA、TLE 还是部分分无法从状态码区分，所以保持 `OTHER` 并原样保留 `raw_status`，同时把 `score` 存进 v4 的 `submissions.score`。满分**由题目决定而不是固定 100**（实测有 30、100 及更大的），因此只报原始分，不折算百分比。`enableO2` 也在载荷里：比较 `execution_time` 时它不是可忽略的变量。

**比赛内编号不计入题目数量。** 同一道月赛题会出现两次：比赛期间的临时编号 `T1234567`，与赛后公开的练习编号 `B4521`，**题名完全相同**。按 `problem_id` 聚合会把一道题算两遍。规则：`T…` 不进尝试题数 / AC 题数 / 题目卡片统计，但提交明细与提交次数照常保留。匹配条件只有一处定义（`src/problem-scope.ts`）并带 `platform = 'luogu'`。实测影响：653 条提交 / 240 道题里，14 个是 `T…` 编号（其中 13 个有 AC），排除后是 226 道尝试、217 道 AC —— 对账 `209（洛谷主页通过题数）+ 8（202605 月赛未公开进题单）+ 13（重复编号）= 230`。

语言暂存官方枚举 ID（实测样本里出现 7 / 28 / 34，尚未核对映射），内存由 KB 转为字节。

## 码蹄集 · `matiji`

已接入**登录态网络同步**，JSON 导入作为备用入口保留。账号管理选择码蹄集，输入自己的昵称、粘贴自己的主页链接或留空，直接保存即可自动识别数字 ID 并开始近期同步。首次使用粘贴一次自己的 Cookie，已有配置会自动沿用；昵称必须与登录账号一致，否则不绑定。也可先点「识别我的账号」查看登录身份；自己的 /personalcenter/homepage 地址通常不含 ID。他人账号可填已知数字 ID 或完整的 /exam/other-homepage/<ID> 链接。配置在本机保存，所有码蹄集账号共用；以后直接同步，登录过期再更新。无需整理 JSON 或手改配置。

近期同步默认查询近一年、最多 100 条；历史回补按日期区间和每页 50 条分页，游标固定用户和截止时间，可继续上次进度。历史请求起始为 1970 年，是否接受该日期范围仍待真实登录验证；不代表平台保证提供自注册以来的所有记录。登录失效、业务错误、格式不符、用户不匹配或重复分页都明确失败，整轮账号数据校验后才写入，不会把异常响应当作空记录成功。网络抓取沿用共享限速、取消和任务优先级。

**验证范围：**2026-09-28 已用真实登录态完成账号识别、近期同步与可见历史回补，取得 44 条记录，重复回补未重复入库。该样本不足一页；跨页处理有模拟测试覆盖，尚未用超过 50 条的真实账号验证。

**2026-09-28 接口复核。** 官方 `MyBrushQuestion` 组件明确区分本人和他人，使用以下只读 POST 查询，基地址为 `https://www.matiji.net/exam-back`，请求体为 `application/x-www-form-urlencoded`：

- 他人明细：`/api/queryOtherUserBrushOjProblemLog.do`，参数 `userId`、`start`（偏移，初始 0）、`limit`（页面可选 10/20/50）、`startDate`、`endDate`；另有可选 `questionId`、`judgeResult`、`languageId` 筛选。
- 本人明细：`/api/queryMyBrushOjProblemLog.do`，同一组件在本人页面调用，不依赖目标 userId。
- 他人日历统计：`/api/queryOtherUserBrushOjProblemStatus.do`，参数 `userId/startDate/endDate`，前端使用 `createDate/submitCount` 绘制热力图，不能代替逐次提交。

明细组件按 `error_no == 0` 判断成功，从 `data.datas` 取记录、`data.total` 取总数；展示 `problemId`、`ojProblemEntity.ojNumber/problemName/difficultyLevel`、`submitTime`、`judgeResult`、`usedTime`、`usedMemory`、`ojLanguage.languageName`。上述记录字段已通过真实登录响应解析并入库；跨页排序稳定性和翻页完整性仍需更大样本验证。页面提供近一年及往年筛选，不能因此宣称无限历史可取。

他人明细和统计接口均已匿名实测：HTTP 200，但业务响应为 `error_no: "2"`、`你还未登陆，请先登陆！`。因此不能把 HTTP 200 当成抓取成功。有效登录态下的账号识别与记录获取现已实测成功；新配置仍以同步结果为准。

来源：[官方 API 模块](https://www.matiji.net/exam/_nuxt/699031c.js)、[官方刷题列表及他人主页组件](https://www.matiji.net/exam/_nuxt/0e340eb.js)。本次研究脚本副本保存在 `output/platform-api-research/`，未保存登录凭据或用户提交源码。

备用文件方式：把已导出的 OJ 记录整理到 `data/matiji-records.json`，格式如下（示例值请替换为真实记录）：

```json
{
  "account_handle": "你的码蹄集账号ID",
  "records": [
    {
      "submissionId": "提交ID",
      "problemId": "题目ID",
      "problemTitle": "题目标题",
      "judgeResultSlug": "Accepted",
      "submitTime": 1700000000,
      "languageName": "C++"
    }
  ]
}
```

`submitTime` 可为 Unix 秒或毫秒；`account_handle` 必须与绑定账号一致；提交 ID、题目 ID、时间必填。只放记录字段，不放 Cookie、Token 或源代码。旧配置 `ALGORITHM_DX_MATIJI_SNAPSHOT_<本地账号ID>=data/matiji-records.json` 显式指定文件来源，优先于 Cookie；改用网络同步时需移除此项。网页备用导入不会设置此项。文件上限 10 MB。`sync` 会读取并去重入库，`--limit` 控制导入条数；文件更新后用 `--force` 绕过 60 秒缓存。定时任务可以重读文件，但不会替你从码蹄集更新文件。

## 同步与登录凭据

- `.env` 默认不提交到 Git；程序不把 Cookie 写入 SQLite 或错误日志，也不会自动从浏览器提取凭据。`cli.ts` 与 `server.ts` 都会在启动时加载项目根的 `.env`，修改后需重启 watch / dashboard 才生效。
- 缓存 60 秒；强制同步绕过缓存。同步前清理过期缓存。命中缓存仍会记录一次同步，覆盖信息标注 `cached`。
- 401/403、响应非 JSON、GraphQL 错误、账号不匹配分别明确报错。网络错误、429 和 5xx 最多三次尝试，每次 15 秒超时；长时间限流留到下一轮处理。
- `history_complete` 仅指遍历完该数据源当前可见历史，不保证平台全部历史完整。部分平台永久不支持回补，单独指定支持的平台账号运行 `--backfill`。
- 当前 SQLite 数据库内共享请求限流和同步锁；不同数据库之间没有协调。watch 仅在本地进程运行时有效，不安装系统后台服务。

### 首页数据覆盖提示

支持历史回补的平台才显示“历史尚未回补完整”。仅支持近期记录的平台在首次同步成功后显示中性的数据范围说明；不能通过回补获取的记录不再被标成未完成任务。缺少登录凭据或导入文件的账号仍显示待处理提示，并提供账号管理入口。批量回补跳过不支持历史的平台，不产生失败日志。

## 牛客（nowcoder）
填写数字用户 ID；读取 https://ac.nowcoder.com/acm/contest/profile/用户ID/practice-coding 的公开编程练习记录。无需凭据，支持近期同步与升序分页历史回补。时间按北京时间解析；保留提交结果、得分、语言、运行时间（ms）和内存（KB）。不覆盖选择题或非公开记录，不提供难度，不参与 B50。页面结构变化或访问限制会报错，不当作空历史。

### 码蹄集网页导入
账号管理 → 码蹄集账号旁「导入记录」→ 选择 JSON → 查看预览 → 确认导入。无需设置本地文件路径或 .env，原有命令行快照配置仍可使用。单文件最多 10 MB、100000 条；所有记录整批校验后导入，不截取最近 100 条。提交 ID 去重，账号不匹配或冲突时不写入。导入不会宣称历史完整，也不会自动下载源站记录。

### Codeforces Group 比赛
账号旁「Group 比赛」配置完整链接及官方 API Key / Secret。通过签名 contest.status 请求读取授权可见提交，账号按 handle 过滤；近期默认每场最多 100 条，回补独立维护各比赛与公开提交的游标。复用全平台限速和同步锁。Key / Secret 不回显；接口异常不写入本轮记录。Group 链接保留，暂不映射到原题；群组链接会自动发现该群组可访问比赛。授权说明：https://codeforces.com/apiHelp 。

CF Group 默认使用独立 Edge / Chrome 登录窗口读取比赛列表和提交分页，保存所选用户名的记录；普通浏览器的登录状态不会自动复制。通过「CF 自建比赛 → 打开 CF 登录窗口」登录后保持窗口开启，可自动发现新增比赛、分页回补历史；登录失效、验证页或权限不足均报错，不视为空数据。API key / secret 签名仍为可选模式，普通参与者可能无法通过 API 读取私有比赛提交。不支持 OAuth App 的 Client id / Client secret，项目没有 OAuth 回调路由。独立登录资料保存在 data/cf-browser（不入版本控制）；无图形桌面的部署请使用 API 模式。详细步骤见网页使用指南「CF 自建比赛」。

Group 配置现在支持群组首页或 /contests 链接，通过带 groupCode 的授权 contest.list 查询普通比赛及 gym 并去重。每轮重新发现比赛（仍受现有短时同步缓存影响），仅抓取绑定用户名的提交。单场配置保持兼容，历史回补继续使用分比赛游标。此功能仍使用 API key 签名，尚未实现 OAuth。

CF Group 普通浏览器扩展：extensions/cf-sync 为 MV3 Edge 扩展。模式 ALGORITHM_DX_CF_GROUP_MODE_<账号ID>=extension，面板生成 ALGORITHM_DX_CF_EXTENSION_TOKEN 配对；扩展经本机鉴权通道领取群组页面读取任务，已登录 CF 标签页读取后返回结构化记录。扩展权限限 CF 和本机面板，不传递 Cookie / 密码 / 源码。接口仅扩展来源和有效令牌可访问；网页写接口保持原同源限制。需通过面板同步，CLI 无扩展任务通道。
