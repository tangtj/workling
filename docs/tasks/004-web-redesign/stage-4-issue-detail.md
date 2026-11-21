# 阶段 4：Issue 详情时间线

> 入口文档见 [README.md](README.md)。前置：阶段 1–3 已合入（用到 `issueStage`、`ServeStatus.reworkLimit`、`countAutoRounds`）。

## 1. 目标

Issue 详情以 Issue 为主体：分诊、各轮运行、反馈放进同一条按时间排列的时间线，每条反馈能看出由哪一轮处理；右侧栏说明怎么接着推进、自动返工用了几轮、交付到哪了。删除过时的「重新打 `workling:ready` 重试」提示。

## 2. 接口 `GET /api/issues/:id/detail`

在现有响应（`src/web/issue-detail.ts` 的 schema，`src/web/routes/pages.ts` 的 `detail`）上增加：

| 字段            | 类型                                        | 说明                                                                                                                                                                                                |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue.stage`   | `Stage`                                     | `issueStage(...)`                                                                                                                                                                                   |
| `issue.branch`  | `string \| null`                            | 最近一轮的 `branch`                                                                                                                                                                                 |
| `issue.baseRef` | `string \| null`                            | 最近一轮的 `baseRef`                                                                                                                                                                                |
| `runs[].branch` | `string \| null`                            | 运行的 `branch`                                                                                                                                                                                     |
| `triage`        | 数组                                        | `triage_records` 中同仓库同编号的记录，按 `triagedAt` 升序；字段：`id`、`decision`、`llmDecision`、`missing`（解析后的字符串数组）、`triagedAt`、`suggestedAt`、`suggestCommentUrl`、`autoQueuedAt` |
| `rework`        | `{ rounds: number; limit: number \| null }` | `rounds` 用 `countAutoRounds`（PR 号取自 `prUrl`，没有 PR 时为 0）；`limit` 取 `ServeStatus.reworkLimit`，无 serve 状态为 `null`                                                                    |

反馈仍用现有 `GET /api/issues/:id/feedback`，不并入 detail。

## 3. 页面 `src/web/client/pages/issue.tsx`

### 3.1 头部（卡片）

- 面包屑不变。
- 第一行：等宽 `#编号` · 阶段徽章（`StageBadge`；`running`/`rework` 时文字为「执行中 · 第 N 轮」/「返工中 · 第 N 轮」，N 为运行总数）· PR 徽章（有 PR 时：`badge--review` 底色，文字「PR #n · 打开中 / 已合并 / 已关闭」）。
- 第二行：标题（`h1`）。
- 第三行小字：「分支 `<branch>` · 基于 `<baseRef>` · 首次入队 <时间> · 共 N 轮 · 累计 <各轮用时之和>」，缺的项省略。
- 右侧按钮：「在 GitHub 打开 Issue」（次要按钮）、「打开 PR #n」（主按钮，有 PR 时才显示）。

删除现有「重试：在 GitHub 上给这个 Issue 重新打上 workling:ready…」提示。

### 3.2 两栏布局

左侧时间线（`flex: 999 1 520px`），右侧栏（`flex: 1 1 300px`），`flex-wrap: wrap`，窄屏时右侧栏落到时间线下方。

### 3.3 时间线（左栏卡片）

卡片标题「时间线」，右侧三个切换按钮：全部 · 只看运行 · 隐藏不算指令的评论（单选，状态存在组件内，不进 URL）。

事件按时间升序合并：

| 事件     | 时间              | 节点                                                                                          | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次入队 | `issue.createdAt` | 小圆点                                                                                        | 「workling 首次入队」                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 分诊     | `triagedAt`       | 小圆点（`--warn` 描边）                                                                       | 徽章「分诊」+ 结论（accept / needs_info / ignore / 无结论）；`llmDecision` 不同时附「LLM：xxx」；有 `missing` 时「缺少：…」；`suggestCommentUrl` 有值时链接「已评论」；`autoQueuedAt` 有值时「已自动打 ready」                                                                                                                                                                                                                         |
| 运行     | `startedAt`       | 大圆点：成功打勾（`--done`）、失败叉（`--failed`）、执行中实心点（`--running` 或 `--rework`） | 标题「第 N 轮 · 实现/返工」+ 结果徽章 + 起止时间；下面嵌入现有 `RunCard` 的内容（用时、退出码、Pi 结论、执行过程、日志链接），只有最新一轮默认展开                                                                                                                                                                                                                                                                                     |
| 反馈     | `createdAt`       | 小圆点（指令为 `--rework` 描边，否则默认）                                                    | 作者 login · 来源（Issue 评论 / PR 评论 / 行内评论 / Review（状态））· 信任来源 · 「算作指令」或「不算指令」· 时间；正文显示 `instruction ?? body` 前 300 字，放在引用框里；行内评论在引用框顶部显示 `path:line`；末尾一行处理状态：`included`/`replied` →「→ 由第 N 轮处理」链接到该轮（`runId` 对应的轮次），`pending` →「→ 已入队」，`observed` →「→ 待处理」，`capped` →「→ 超过自动返工上限，未处理」；「查看原评论」链接到 `url` |

- `isCommand` 为假（含 `ignored` 状态）的反馈整行降低不透明度（0.6）。
- 「只看运行」只显示运行事件；「隐藏不算指令的评论」隐藏 `isCommand` 为假的反馈。
- 节点之间有竖线连接（CSS 伪元素），节点图形 `aria-hidden`，状态同时有文字表达。

现有独立的「反馈」卡片与「执行历史」区块删除，内容已并入时间线。

### 3.4 右侧栏

自上而下四张小卡片：

1. **接着推进**：说明「在 Issue 或 PR 里评论，workling 会在同一分支上接着做：」，下面等宽代码框两行 `/workling 补充：…` 与 `@workling-agent 再看下…`，再一行小字「只有写权限或受信账号的评论算指令。PR 上的 Request changes 会自动触发返工。」。阶段为 `running` / `rework` / `queued` 时改为「正在处理中，新的指令会在本轮结束后接着处理。」
2. **自动返工**（只在有 PR 时显示）：标题右侧「R / L 轮」；一排 L 个小格，前 R 个用 `--rework` 填充；`R >= L` 时下方说明「已用完。之后的 Request changes 只记录，需要评论 /workling 才会继续。」，否则「还可自动返工 L−R 轮」。`limit` 为 `null` 时只显示「已自动返工 R 轮」。
3. **反馈**：键值列表——指令：总数 · 已处理（included + replied）· 处理中（observed + pending）· 超上限（capped，0 时省略）；不算指令：条数；最近：最新一条的作者与相对时间。没有反馈时显示「暂无反馈」。
4. **交付**：键值列表——分支（等宽）、PR（链接 + 状态）、任务目录（最近一轮 `taskDir`，等宽小字）。

## 4. 验收

- [ ] `/api/issues/:id/detail` 返回 `issue.stage`、`issue.branch`、`issue.baseRef`、`runs[].branch`、`triage`、`rework`，schema 校验通过；有测试覆盖「有 PR、2 轮自动返工、上限 3」时 `rework` 为 `{ rounds: 2, limit: 3 }`。
- [ ] 时间线按时间合并三类事件；反馈「由第 N 轮处理」的 N 与运行标题一致并能跳到该轮。
- [ ] 三个切换按钮行为符合第 3.3 节。
- [ ] 页面不再出现「重新打上 workling:ready」的重试提示。
- [ ] 1100px 以下右侧栏落到时间线下方；375px 下页面不横向滚动。
- [ ] 执行中的运行仍能实时刷新（沿用现有 `onFinished` 失效逻辑）。
- [ ] `bun run check` 通过。

## 5. 不做

- 不记录、不显示标签变化（谁在何时打了 ready）和 PR 创建时间点。
- 不显示提交数量与待办勾选进度。
- 不在页面上提供取消、重试等写操作。
- 执行日志页 `/runs/:id/log` 不改。
