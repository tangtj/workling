# 2.3 反馈触发返工

> 入口文档见 [README.md](README.md)（6.3 反馈返工），路线图见 [roadmap.md](roadmap.md)。持续分支、快进推送、上下文包与答复模式已由 [003-issue-continuity](../003-issue-continuity/README.md) 实现；本步只补「反馈驱动返工」：把 2.1 记录下来的可信指令与 `CHANGES_REQUESTED` review 变成真正的运行。

## 1. 目标

- 可信作者在 workling PR 上 Request changes，或在 PR / Issue 里写 `/workling ...`、`@<token 账号> ...`，workling 自动在原 PR 分支上接着改，PR 上出现新提交。
- 每批反馈只处理一次；同一个 Issue 同时只有一个运行，运行期间新来的反馈留到下一批。
- 触发来源统一为 2.1 的 `feedback` 表：现有 `src/serve/retry.ts` 自己拉评论、只认 token 账号的逻辑删除，`/workling` 失败重试改走同一套规则，信任规则随之放宽为 2.1 的判定（写权限 + 受信账号）。

逐条回复（`replies.json`）与自动返工轮数上限属于 2.4，本步不做。

## 2. 触发规则

新增 `src/serve/rework.ts`，导出 `queueRework({ db, command, log, signal })`，在 `src/serve/index.ts` 主循环中替换 `retryOnCommand`（仍在 `observeFeedback` 之后、`launchQueued` 之前）。`src/serve/retry.ts` 删除，`matchCommandPrefix` 移到 `src/serve/feedback.ts`；`test/serve-retry.test.ts` 改写为 `test/serve-rework.test.ts`。

### 2.1 候选 Issue

与现有 `retryOnCommand` 相同：仓库 `enabled` 且 `platform = 'github'`；Issue `status` 为 `done` 或 `failed`，`prState` 为空或 `open`，且有 `lastRunId`（取其 `runs.startedAt` 作为本批的时间下限）。

### 2.2 一批反馈

候选 Issue 的 `feedback` 中同时满足以下条件的行构成本批：

- `status = 'observed'`（2.1 已保证只有 `trust` 为 `allowlist` / `write` 且算作指令的行是这个状态）；
- `createdAt` 晚于该 Issue 上一次运行的 `startedAt`；
- `prNumber` 为空（Issue 评论），或等于 `issues.prUrl` 末尾的 PR 号（旧 PR 上的评论不算）。

本批为空则跳过。决策部分写成纯函数 `selectBatch(candidate, rows)`，用表驱动用例测试。

更早的 `observed` 行（2.1 上线后只观察、未处理的记录）不回溯，保持原状。

### 2.3 运行类型

- `prState = 'open'` → `kind = 'rework'`。
- 其他（运行失败且没有 PR，或已完成但没有 PR）→ `kind = 'implement'`，等价于现有的「带补充说明重试」。

`kind` 只在拉起时根据当时的 `prState` 计算（见 3.1），入队时不存。

### 2.4 入队

对每个本批非空的 Issue，在一个事务里：

1. 条件更新 Issue：`status` 仍为入队前读到的值时改为 `queued`（与现有逻辑相同，防止并发改动）；没更新到则整批放弃。
2. 本批反馈 `observed → pending`。

事务成功后按现有方式改标签（`workling:<原状态>` → `workling:queued`），失败只记日志。日志：`<仓库> #<号> 收到 <n> 条反馈，重新入队`。

现有 `RetryState.triggers`（内存中的触发链接）删除，领取评论改为从数据库读取本次运行包含的反馈（见 3.3）。

## 3. 拉起

改 `src/serve/launch.ts`。

### 3.1 认领反馈与类型

建出 `runs` 记录之后、准备工作区之前：

- 该 Issue 所有 `pending` 反馈改为 `included`，`runId` 写本次运行 ID。
- 若其中有 `source = 'review'` 的行，同一 review 下的行内评论也一并 `included`（无论原状态是 `ignored` 还是 `observed`）。归属靠新字段 `feedback.reviewId`，见第 5 节。
- `kind`：有 `included` 反馈且 `issue.prState = 'open'` 时为 `rework`，否则为 `implement`。写入 `runs.kind` 与 `spec.json`。
- 进入现有 `catch`（拉起失败，Issue 仍是 `queued`、下轮重试）时，把本次 `runId` 的反馈改回 `pending`、`runId` 置空，下次拉起重新认领。

### 3.2 返工必须接续

`kind = 'rework'` 时，`prepareCheckout` 必须接续上一次运行的分支（即 003 的 `continuedBranch` 成立）。不成立时不新建分支，直接返回错误，走现有「准备失败 → 写 `result.json` 错误 → 对账判失败并评论」的路径：

- 镜像中没有上次分支：`PR 分支「<分支>」不存在，无法返工`。

拉起时 `issue.prState` 已变为 `merged` / `closed`（排队期间 PR 被合入或关闭），且有 `included` 反馈时，同样直接返回错误：`PR 已合入或关闭，不再返工；新需求请另开 Issue`。不能落到「从起点重开」。

推送沿用 003 的规则：远端分支等于基点时快进推送，否则判失败，不强推。人在排队期间往 PR 分支推了提交时，镜像同步后基点就是新 tip，不受影响。

### 3.3 领取评论

现有领取评论的「触发」一行改为列出本次 `included` 的反馈（按 `createdAt` 升序，最多 10 条，超出写「等 n 条」），每条一行：`- <来源中文名> · @<作者> · <url>`。来源中文名：`issue_comment` Issue 评论、`pr_comment` PR 评论、`review_comment` 行内评论、`review` Review。没有反馈时不写这一行。

`kind = 'rework'` 时首行改为 `workling：收到 PR 反馈，开始返工。`，其余不变。

## 4. 输入：`input/feedback.md`

在 `src/serve/context.ts` 的 `writeRunContext` 中新增（按已有的 `runId` 参数查询，另加 `kind` 参数）。内容为本次 `included` 的反馈，按 `createdAt` 升序：

```md
# 本轮反馈

类型：rework

## F12 · Review（CHANGES_REQUESTED）· @alice · 2026-11-21T08:00:00Z

链接：https://github.com/...

<instruction ?? body>

## F13 · 行内评论 · @alice · 2026-11-21T08:00:00Z

位置：src/serve/land.ts:120
链接：https://github.com/...

<instruction ?? body>
```

- 标题中的 `F<id>` 是 `feedback.id`，2.4 的 `replies.json` 用它对应回复。
- 指令行（`isCommand = true`）用 `instruction`，为空时用 `body`；同 review 下附带的行内评论用 `body`。
- 每条正文超过 8000 字符截断并注明；整体经 `redactSecrets` 处理，并用现有 `truncateComment` 限制总长度。
- 没有反馈时写 `无本轮反馈。`

## 5. 数据结构

drizzle 迁移（`bun run db:generate`）：

- `runs.kind`：text enum `implement` / `rework`，非空，默认 `implement`（旧记录取默认值）。
- `feedback.reviewId`：text，可空。`review_comment` 行写 GitHub 返回的 `pull_request_review_id`（存字符串），其他来源为空。`src/serve/feedback.ts` 的评论 schema 增加可选字段 `pull_request_review_id: Integer | Null`，插入时写入；已有行不回填。
- `feedback.status`：2.1 已声明 `pending` / `included`，本步开始写入。`feedback.ts` 的 upsert 规则不变——只有 `ignored` / `observed` 状态的行在编辑后会被覆盖，`pending` / `included` 的行不再改动。

契约（`src/contract/spec.ts`）：

- `kind` 改为 `Type.Union([Type.Literal('implement'), Type.Literal('rework')])`。
- `CONTRACT_VERSION` 改为 2（主体与 worker 仍同版本发布，只是如实标明契约变化）。
- `src/task/index.ts` 在给 Pi 的用户消息中加一行 `运行类型：<kind>`。

## 6. Pi 提示词

改 `configs/workling/AGENTS.md`：

- 第 1 步「读取」的文件列表加上 `input/feedback.md`。
- 「判断模式」：`feedback.md` 中有反馈时，以这批反馈为准判断答复或实现，不再看 `issue.md` 中最新的 `/workling` 评论；没有反馈时保持现有规则。
- `运行类型：rework` 时：在 PR 分支上逐条处理 `feedback.md` 中的反馈，不扩大范围、不重做已完成的部分；「本轮简报」的「本轮目标」逐条列出 `F<id>` 与要做的修改，codex 输入中原样附上 `feedback.md`。
- `out/issue-comment.md` 中按 `F<id>` 逐条说明处理结果（已改 / 未改及原因）。2.4 之前这份说明仍由主体作为一条评论发出。

## 7. Web

`src/web/` 中 Issue 详情页「反馈」区块的状态文案：

| `status`   | 显示                       |
| ---------- | -------------------------- |
| `ignored`  | 不算指令（保持现状）       |
| `observed` | 指令（待处理）             |
| `pending`  | 已入队                     |
| `included` | 已处理，链接到运行 `runId` |

执行记录中显示运行类型（`implement` 显示「实现」，`rework` 显示「返工」）。只改文案与现有接口字段，不新增页面。`GET /api/issues/:id/feedback` 的返回增加 `reviewId`；运行相关接口增加 `kind`。

## 8. 测试

- `selectBatch`：`observed` 才入批；早于上次运行开始的不入批；旧 PR 号的 PR 评论不入批；`ignored` / `pending` / `included` 不入批。
- 入队：`done` + PR open 的 Issue 收到 `CHANGES_REQUESTED` 后变 `queued`、反馈变 `pending`、标签被替换；`running` / `queued` 的 Issue 不入队（运行期间的反馈留在 `observed`，运行结束后的下一轮才入队）；Issue 状态被并发改动时整批放弃。
- 信任：写权限账号（非 token 账号）的 `/workling` 评论能触发；`untrusted` / `bot` / `self` 的不触发（由 2.1 的 `status` 保证，用例覆盖端到端）。
- 拉起：`pending` → `included` 并写 `runId`；同 review 下的行内评论一并 `included`；拉起失败回滚为 `pending`；`kind` 按 `prState` 计算并写入 `runs.kind` 与 `spec.json`；返工时镜像缺分支、PR 已关闭两种情况判失败且不新建分支。
- `input/feedback.md`：格式、`F<id>`、行内评论位置、截断、无反馈时的文字。
- 领取评论：列出反馈链接、超过 10 条的写法、返工首行。
- 关键连接处沿用 003 的真实 bare Git 用例：PR 分支上已有提交，返工运行产出新提交后快进推送到同一分支、PR 不新建。

## 9. 验收

- [ ] 对 PR 仍开着的 workling Issue，可信账号提交 `CHANGES_REQUESTED` review 后，下一轮轮询自动入队，返工运行在同一 PR 分支上推送新提交，不新开 PR。
- [ ] 在 PR 或 Issue 里写 `/workling <说明>`（作者有写权限或在受信账号中，不必是 token 账号）同样触发；无权限账号写的不触发。
- [ ] 同一条反馈只触发一次；运行期间收到的反馈在本次运行结束后作为下一批处理。
- [ ] 任务目录 `input/feedback.md` 列出本批反馈，`spec.json` 与执行记录中 `kind` 为 `rework`。
- [ ] Issue 详情页的反馈状态从「指令（待处理）」变为「已入队」「已处理」。
- [ ] `src/serve/retry.ts` 已删除，失败后 `/workling` 重试仍可用。
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。

## 10. 不做

- 按 `replies.json` 逐条回复、行内评论回到原线程、自动返工轮数上限：2.4。
- `review` 类型（workling 自己 review）：暂缓。
- 普通评论（无前缀、非 `CHANGES_REQUESTED`）的意图识别、CI 失败或基点冲突触发返工：以后按影子模式另做。
- 回溯处理 2.1 观察期间积累的 `observed` 记录。
- GitLab。
