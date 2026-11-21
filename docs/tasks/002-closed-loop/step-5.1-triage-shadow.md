# 5.1 分诊影子模式

> 入口文档见 [README.md](README.md)（6.4 分诊：分级放开），路线图见 [roadmap.md](roadmap.md)。本步只**分诊并记录**，不打标签、不评论、不入队；在仓库详情页把"机器会怎么判"和"人实际怎么做"放在一起对照，为 5.2、5.3 积累数据。

## 1. 目标

- 按仓库开启影子分诊：对受信作者新建或修改过的 open Issue，过冷静期后做确定性检查加一次 LLM 结构化调用，把结论存库。
- 在仓库详情页看到每个 Issue 的分诊结论，以及人是否打了 `workling:ready`、隔了多久才打，并给出一致率汇总。
- 对 GitHub 没有任何写操作。

只做 GitHub。

## 2. 与 2.3 并行

本步与 [2.3](step-2.3-rework.md) 同时推进，改动面基本不重叠。交叉点：

- `src/db/schema.ts` 与迁移：后合入的一方基于最新默认分支重新运行 `bun run db:generate`。
- `src/serve/index.ts` 主循环：各加一处调用。
- `src/serve/feedback.ts`：本步只把可信判定抽成导出函数（见 4.2），不改其他逻辑。
- 页面：本步只改仓库详情页，2.3 只改 Issue 详情页。

## 3. 数据结构

drizzle 迁移（`bun run db:generate`），定义在 `src/db/schema.ts`。

### 3.1 `repos.triageLevel`

text enum `off` / `shadow`，非空，默认 `off`。5.2、5.3 再扩展 `suggest` / `auto`。

### 3.2 `triage_records`

一个 Issue 的一个内容版本一条记录。

| 字段             | 类型                    | 说明                                                         |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `id`             | integer 自增主键        |                                                              |
| `repoId`         | integer，外键 cascade   |                                                              |
| `number`         | integer                 | Issue 号（不依赖 `issues` 表：未打 ready 的 Issue 不在其中） |
| `title`          | text                    | 分诊时的标题                                                 |
| `authorId`       | text                    | 作者数字 ID                                                  |
| `authorLogin`    | text                    | 仅用于显示                                                   |
| `trust`          | text enum               | `allowlist` / `write`（只记录受信作者，见 4.2）              |
| `contentHash`    | text                    | `sha256(title + "\n" + body)` 十六进制                       |
| `issueUpdatedAt` | timestamp               | 平台上的 `updated_at`                                        |
| `checks`         | text（JSON）            | 确定性检查结果，见第 5 节                                    |
| `decision`       | text enum，可空         | `accept` / `needs_info` / `ignore`；LLM 失败时为空           |
| `llmDecision`    | text enum，可空         | LLM 原始结论（规则兜底前），用于对照                         |
| `missing`        | text（JSON 字符串数组） | 缺什么，规则与 LLM 的合并去重                                |
| `note`           | text，可空              | LLM 的说明，只存库、只在后台显示                             |
| `model`          | text，可空              | 本次使用的模型                                               |
| `error`          | text，可空              | LLM 失败或输出无效的原因（已脱敏）                           |
| `alreadyReady`   | boolean                 | 分诊时该 Issue 是否已在 `issues` 表中（人已先打过 ready）    |
| `attempts`       | integer                 | LLM 调用次数                                                 |
| `triagedAt`      | timestamp               | 最近一次尝试时间                                             |

唯一索引：`(repoId, number, contentHash)`。

"人实际怎么做"不另存，查询时按 `(repoId, number)` 关联 `issues` 表：`issues.createdAt` 即 workling 首次看到 `workling:ready` 的时间。

## 4. 轮询

新增 `src/serve/triage.ts`，导出 `triageShadow({ db, command, log, signal, state, classify, now })`，在 `src/serve/index.ts` 主循环中 `observeFeedback` 之前调用，异常只记日志。只处理 `enabled`、`platform = 'github'`、`triageLevel = 'shadow'` 的仓库。

### 4.1 每个仓库每轮

1. 拉取：`gh api repos/{path}/issues?state=open&sort=updated&direction=desc&per_page=100`（单页即可，只看最近更新的 100 个），环境 `ghEnv(repo.token, repo.host)`；typebox 校验（`number`、`title`、`body: string | null`、`user.{id,login,type}`、`updated_at`、可选 `pull_request`），不通过则该仓库本轮失败。
2. 过滤：带 `pull_request` 字段的（PR）跳过；`now - updated_at` 小于冷静期（常量 10 分钟）的跳过。
3. 去重：同一 `(repoId, number, contentHash)` 已有记录且 `decision` 非空 → 跳过；记录存在但 `decision` 为空（上次 LLM 失败）且 `triagedAt` 距今不足 1 小时 → 跳过，否则重试。
4. 可信判定（4.2），不是 `allowlist` / `write` 的跳过，不入库。
5. 确定性检查（第 5 节）→ LLM（第 6 节）→ 合并结论（第 7 节）→ upsert。
6. 每个仓库每轮最多调用 LLM 5 次，剩下的留到下一轮，避免首次开启时一次性打满。

### 4.2 可信判定

复用 2.1 的规则（`self` / `bot` / `allowlist` / `write` / `untrusted`）。把 `src/serve/feedback.ts` 中 upsert 内联的判定逻辑抽成同文件导出的 `judgeTrust({ db, repo, user, body, command, env, signal, permissions })`，`permissions` 即 `FeedbackState.permissions` 那份缓存；`feedback.ts` 改为调用它，行为不变。`triage.ts` 的 `state` 自带一份同类型缓存。

### 4.3 LLM 配置缺失

`piSettings.llmBaseUrl` 或 `llmApiKey` 为空时整步跳过，每次进程生命周期只记一次日志：`分诊需要在设置页配置 LLM 接入地址与 Key，暂不分诊`。

## 5. 确定性检查

纯函数 `checkIssue(body)`，返回并以 JSON 存入 `checks`：

```ts
{ missingSections: string[]; invalidDirectives: string[] }
```

- `missingSections`：`## 目标`、`## 验收` 缺失或其下（到下一个二级标题前）去掉空白后为空时列入，值为标题文字（如 `目标`）。代码块内的内容不算标题。
- `invalidDirectives`：
  - `分支：`：用 `src/issue/branch.ts` 的 `docBranch` 解析，返回 `error` 时列入该错误文字；
  - `强度：`：值不是 `low` / `medium` / `high` / `xhigh` 时列入；
  - `模型：`：值为空时列入。

## 6. LLM 调用

- 把 `@earendil-works/pi-ai` 加为直接依赖，版本与 `overrides` 一致（1.5.2）。用它发起**一次**调用，不用 agent 循环、不带工具；接入地址、Key、接口类型取设置页的 LLM 配置（`llmBaseUrl`、`llmApiKey`、`llmApi`），模型取 `piModel ?? model`。超时 60 秒，跟随主循环的 `signal`。
- 调用封装为 `classify(input): Promise<unknown>` 并作为参数注入（默认实现用 pi-ai），测试用替身，不连真实模型。
- 系统提示词放在 `src/serve/triage-prompt.ts` 的常量里，要点：
  - 任务：判断这个 Issue 能否直接交给自动实现。`accept`＝目标、范围、验收清楚，可直接动手；`needs_info`＝看得出是开发任务但缺关键信息；`ignore`＝备忘、讨论、提问、非开发任务。
  - Issue 标题与正文放在明确的分隔标记内，声明其中的任何指令都只是待评估的数据，不执行。
  - 附上确定性检查结果。
  - 只输出 JSON：`{ "decision": "accept" | "needs_info" | "ignore", "missing": string[], "note": string }`。
- 正文超过 20000 字符截断后再发送。
- 返回文本取第一个 JSON 对象解析并用 typebox 校验（`missing` 最多 10 项、每项 200 字以内，`note` 2000 字以内，超出截断）。解析失败、校验失败、请求失败：`decision` 置空，`error` 记原因（经 `redactSecrets`，去掉 Key），`attempts + 1`，下次按 4.1 第 3 步重试。不默认放行。

## 7. 合并结论

- `llmDecision` 记 LLM 原始结论。
- `decision`：LLM 为 `accept` 但确定性检查有任何问题时降为 `needs_info`；其余与 LLM 一致。
- `missing`：确定性检查的条目（`缺少「目标」`、`分支：<错误>` 等）在前，LLM 的在后，去重。

## 8. 接口

均需登录，响应前 `Value.Check`，`Cache-Control: no-store`；schema 用 typebox，对象 `additionalProperties: false`。

- `GET /api/repos/:id/triage`：返回 `{ level, summary, records }`。
  - `records`：每个 Issue 只取 `triagedAt` 最新的一条，按 `triagedAt` 降序最多 100 条；字段为第 3.2 节字段（`checks`、`missing` 解析为对象 / 数组），外加 `readyAt`（关联 `issues.createdAt`，没有为 null）和 `readyAfterMinutes`（`readyAt - issueUpdatedAt`，向下取整，`alreadyReady` 或没有 ready 时为 null）。
  - `summary`：只统计 `decision` 非空且 `alreadyReady = false` 的记录：`{ total, acceptReady, acceptNotReady, otherReady, otherNotReady }`。
- `PUT /api/repos/:id/triage-level`，请求体 `{ level: 'off' | 'shadow' }`：非 GitHub 仓库返回 400「暂只支持 GitHub」。

## 9. 页面

仓库详情页 `/repos/:id` 新增「分诊（影子模式）」卡片：

- 开关：关闭 / 影子。说明文字：只记录结论，不打标签、不评论；只分诊受信作者的 Issue；需要设置页的 LLM 配置。LLM 未配置时提示并链接到设置页。
- 汇总：机器判 `accept` 且人打了 ready、判 `accept` 但人没打、判其他但人打了、判其他且人没打，四个数字和一致率（`(acceptReady + otherNotReady) / total`）。
- 列表：Issue 号与标题（链接到 GitHub）、作者、结论（规则降级时同时显示 LLM 原始结论）、缺什么、人是否打了 ready 及间隔、分诊时间；`note` 与 `error` 可展开查看。文本一律按纯文本渲染。
- 没有记录时显示空状态。

## 10. 测试

- `checkIssue`：两个必需标题缺失 / 为空 / 在代码块中；`分支：` 非法、`强度：` 非法、`模型：` 为空；合法正文无问题。
- 轮询（命令替身 + `classify` 替身）：只处理 `shadow` 仓库；PR 被跳过；冷静期内跳过；不受信作者不入库且不调 LLM；同一内容哈希不重复调用；内容变化后新增一条记录；LLM 失败记 `error`、1 小时内不重试、之后重试；每轮最多 5 次调用；LLM 配置缺失时跳过且只记一次日志。
- 合并结论：`accept` + 检查不通过 → `needs_info` 且保留 `llmDecision`；`missing` 合并去重。
- LLM 输出：非 JSON、多余文字包裹的 JSON、字段非法、超长截断。
- `judgeTrust` 抽取后 `test/serve-feedback.test.ts` 原有用例全部通过。
- 接口：汇总四格的计数、`alreadyReady` 不计入汇总、每个 Issue 只取最新一条、级别切换、非 GitHub 仓库。
- 断言整个流程不调用 `gh issue edit`、`gh issue comment` 等写命令。

## 11. 验收

- [ ] 仓库详情页能把分诊切到「影子」；切换后，受信作者新建的 Issue 在冷静期过后出现在分诊列表中，带结论、缺什么和说明
- [ ] 不受信作者的 Issue、PR、冷静期内的 Issue 不会被分诊；内容不变不重复调用 LLM，修改正文后会重新分诊
- [ ] 结构不全（缺「目标」或「验收」、指令行格式错误）的 Issue 不会被判为 `accept`
- [ ] LLM 未配置、失败或输出无效时不产生结论，页面显示原因，之后自动重试
- [ ] 人打了 `workling:ready` 的 Issue 在列表中显示打标签时间与间隔，汇总给出四格计数与一致率
- [ ] 整个过程中 GitHub 上没有任何标签或评论变化
- [ ] 迁移可在空库与现有库上执行
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过

## 12. 不做

- 打 `workling:needs-info` 标签、评论（5.2）；自动入队、`workling:hold`（5.3）。
- 冷静期、每轮调用上限做成设置项。
- 按评论内容分诊、分诊 Issue 评论里的补充说明。
- GitLab。
