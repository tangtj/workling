# 阶段 2：影子级评审

规则总览见 [README.md](README.md)，评审运行的契约与 worker 行为见 [stage-1-worker-review.md](stage-1-worker-review.md)（本阶段依赖阶段 1 已合入）。

本阶段完成后：仓库的评审级别设为 `shadow` 时，workling 每次成功交付都会自动排一次评审，结论记入数据库并显示在 Issue 详情页。**GitHub 上没有任何可见变化**：不发评论、不改标签、不触发返工。

## 1. 数据库：`src/db/schema.ts`

用 `bun run db:generate` 生成迁移。

### 1.1 `repos`

```ts
reviewLevel: text('review_level', { enum: ['off', 'shadow'] }).notNull().default('off'),
reviewSince: integer('review_since', { mode: 'timestamp' }),
```

`reviewSince` 是最近一次修改级别的时间，只用于展示。后续阶段会给 `reviewLevel` 增加 `comment`、`auto`。

### 1.2 `pi_settings`

```ts
reviewModel: text('review_model'),
reviewEffort: text('review_effort', { enum: ['low', 'medium', 'high', 'xhigh'] }),
```

两者都可为空。评审实际使用的值：`reviewModel ?? model`，`reviewEffort ?? 'high'`。`PiSettings`、`parsePiSettings`、`readPiSettings` 及保存设置的接口同步增加这两个字段；空字符串按未设置（`null`）处理。

### 1.3 `runs`

`kind` 的枚举增加 `'review'`。评审运行的 `branch` 与 `stackBranch` 保持 `null`，`baseRef` 写评审范围的起点提交。

### 1.4 新表 `reviews`

一行是一次评审请求及其结果。

```ts
export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    // 触发这次评审的交付运行（implement / rework）。
    deliveryRunId: integer('delivery_run_id').notNull(),
    prUrl: text('pr_url').notNull(),
    branch: text('branch').notNull(),
    // 交付时推送到远端的分支末端。
    headSha: text('head_sha').notNull(),
    // 交付时是否为部分完成（draft PR）。
    partial: integer('partial', { mode: 'boolean' }).notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'skipped'] }).notNull(),
    // 评审运行，拉起后写入。
    runId: integer('run_id'),
    model: text('model'),
    effort: text('effort'),
    verdict: text('verdict', { enum: ['pass', 'changes'] }),
    summary: text('summary'),
    // 以下三列存 JSON 文本，内容即 out/review.json 的同名字段。
    checks: text('checks'),
    acceptance: text('acceptance'),
    findings: text('findings'),
    // failed / skipped 的原因。
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
  },
  (table) => [uniqueIndex('reviews_delivery_run_unique').on(table.deliveryRunId)],
)
```

## 2. 排队：`src/serve/land.ts` 与 `src/serve/reconcile.ts`

1. `landRun` 成功时返回的 `Landed` 增加两个字段：`head: string`（最终推送到远端的分支末端，即现有变量 `tip` 在推送时的值；发生堆叠变基时是变基后的值）和 `partial: boolean`（本次是否按部分完成交付）。
2. `reconcile` 在交付成功（`landed.status === 'done'`）并保存 Issue 终态的**同一个事务**里：如果 `repo.reviewLevel !== 'off'`，插入一行 `reviews`：`status: 'queued'`，`deliveryRunId` 为本次运行，`prUrl`、`branch`（`run.branch`）、`headSha`、`partial` 取自交付结果。用 `onConflictDoNothing`，对账重试不会重复插入。
3. 答复运行（`landed.status === 'answered'`）和交付失败不排评审。

## 3. 拉起与对账：新建 `src/serve/review.ts`

评审运行有自己的生命周期，不经过 `issues.status`。导出两个函数，由主循环调用。

### 3.1 `launchReviews`

入参与 `launchQueued` 相同（`db`、`command`、`log`、`settings`、`pi`、`executorSettings`、`signal`、`now`、`executor`）。

**并发名额**：评审与实现共用 `executorSettings.concurrency`。

- 「进行中的评审」定义为 `runs.kind = 'review'` 且 `endedAt` 为空的运行数。
- `launchQueued` 计算 `slots` 时也要减去进行中的评审数。
- `launchReviews` 的可用名额 = `concurrency` − `status = 'running'` 的 Issue 数 − 进行中的评审数。主循环先调 `launchQueued` 再调 `launchReviews`，所以实现任务优先拿名额。

docker 执行器且未配置 LLM 接入地址时不拉起（与 `launchQueued` 相同的判断，不重复记日志）。

对每个 `status = 'queued'` 的评审（按 `id` 升序，仓库须 `enabled` 且为 `github.com`），名额用完即停：

1. **跳过判断**（命中则把评审置为 `skipped`、写 `error` 与 `endedAt`，不占名额）：
   - `repo.reviewLevel === 'off'` → `评审已关闭`；
   - 同一 Issue 存在 `id` 更大的评审请求 → `已有更新的交付`；
   - Issue 当前 `status` 为 `queued` 或 `running` → `Issue 正在执行，等待下一次交付`。
2. `syncMirror`，在镜像里确认 `headSha` 存在（`git cat-file -e <headSha>^{commit}`）。不存在 → `skipped`，`提交 <headSha 前 7 位> 已不在仓库中`。
3. 读取 PR：`gh pr view <prUrl> --json baseRefName,headRefOid`，用 typebox 校验。
   - `headRefOid !== headSha` → `skipped`，`PR 已有新的提交`；
   - 在镜像里计算 `git merge-base refs/heads/<baseRefName> <headSha>` 得到 `baseSha`。base 分支不在镜像中（上游分支已删除）时，改用默认分支（`readDefaultBranch`）计算；仍失败 → `skipped`，`无法确定评审范围`。
4. 创建任务目录（`createTaskDir`），插入 `runs`：`issueId`、`kind: 'review'`、`worker`、`taskDir`、`startedAt`、`baseRef: baseSha`。
5. 准备工作副本：与 `prepareCheckout` 相同的方式从镜像克隆到 `<任务目录>/repo`（`--no-hardlinks --no-checkout --dissociate`，`origin` 指向镜像，禁用 push，写入 `user.name` / `user.email`），然后 `git switch -c <branch> <headSha>`。把 `prepareCheckout` 里克隆与配置的那一段抽成一个函数，两处共用。
6. 准备输入：
   - `readIssue` 写 `input/issue.md` 与附件（与 `launchQueued` 相同）；
   - 调用 `writeRunContext`，`runId` 为评审运行、`kind: 'review'`、不传 `chain`，`checkout` 为 `{ baseRef: baseSha, branch, start: <base 分支名> }`，Issue 正文有文档分支时带上 `docBranch`。
7. 写 `spec.json`：`kind: 'review'`，`repo: { baseRef: baseSha, branch, docBranch? }`，`model: { codex: pi.reviewModel ?? pi.model, effort: pi.reviewEffort ?? 'high', pi? }`，其余与实现运行相同。有 LLM 配置时写 `secrets/llm.json`。
8. `executor.start(...)`，把 `pid` / `container` 写回 `runs`；评审置为 `running`，写入 `runId`、`model`、`effort`。
9. 任一步抛错：删除已写入的密钥，`runs` 写 `endedAt` 与 `error: '拉起失败：…'`，评审**保持 `queued`**，下一轮重试；记日志 `<repo> #<号> 评审拉起失败：…`。同一评审连续 3 次拉起失败后置为 `failed`（失败次数用模块内的 `Map` 记录即可，重启后重新计数）。

不改标签，不发评论。

### 3.2 `reconcileReviews`

入参与 `reconcile` 相同。对每个 `status = 'running'` 的评审（连同它的 `runs` 记录）：

1. 读 `result.json`（`readResult`）：
   - 还没有：`executor.status`。仍在运行时按 `settings.timeout` 处理超时，做法与 `reconcile` 相同（先写 `runs.error = '超时'` 并发 `SIGTERM`，下一轮仍在运行则 `SIGKILL`），本轮不收尾。已不在运行 → 失败，原因 `超时`、`内存不足（OOM）` 或 `进程丢失`。
   - `invalid` → 失败，`result.json 无效`。
   - 有结果但 `exitCode !== 0` 或带 `error` → 失败，原因取 `runs.error ?? result.error ?? 信号 / 退出码`。
   - `exitCode === 0` 且无 `error` → 读 `readReview(<任务目录>/out)`；读取或校验失败 → 失败，原因为错误信息。
2. 收尾（成功与失败都执行）：`executor.finish`，`removeSecrets`，`extractSummary` 取 `logTail`；`runs` 写 `endedAt`、`exitCode`、`error`、`logTail`。
3. 评审记录：成功 → `status: 'done'`，写 `verdict`、`summary`，`checks` / `acceptance` / `findings` 存 `JSON.stringify` 后的文本，写 `endedAt`；失败 → `status: 'failed'`，写 `error`、`endedAt`。第 2、3 步的数据库写入放在同一个事务里。
4. 记日志：`<repo> #<号> 评审完成：<pass|changes>，<n> 条发现` 或 `<repo> #<号> 评审失败：<原因>`。日志与 `error` 经 `redactSecrets` 处理。
5. 单个评审处理抛错时记日志并继续下一个，下一轮重试。

**启动恢复**：`serve` 启动时（现有 `recoverOrphanFeedback` 调用处旁边），把 `status = 'running'` 但对应 `runs` 的 `pid` 与 `container` 都为空、`endedAt` 为空的评审改回 `queued`，并给那条 `runs` 写 `endedAt` 与 `error: '拉起中断'`。

### 3.3 主循环：`src/serve/index.ts`

- `reconcile` 之后调用 `reconcileReviews`；
- `launchQueued` 之后、在同一个「未暂停且 worker 可用」的条件下调用 `launchReviews`；
- 两处各自 `try/catch`，失败记 `评审对账失败：…` / `拉起评审失败：…`。

## 4. 不让评审运行影响现有逻辑

评审运行写在 `runs` 表里，是为了复用任务目录清理和运行日志页。下面这些按 Issue 查「历次运行」或「最近一次运行」的地方必须排除 `kind = 'review'`：

- `src/serve/context.ts` 生成 `runs.md` 的查询（评审结论在影子级不能进入实现方的输入）；
- `src/serve/launch.ts` 查上一次带分支的运行（`previous`）；
- `src/serve/pr-sync.ts` 查上游最近一次运行（`upstreamRun`）和下游带 `stackBranch` 的运行；
- `src/web/data.ts` 及其下游（概览、任务列表、阶段、轮次）按 Issue 汇总运行的地方。

`issues.lastRunId` 不会指向评审运行（评审不更新它），依赖它的逻辑不用改。实现前先全局搜索 `from(runs)`，逐处确认；上面没列到但受影响的地方同样处理，并在 PR 正文里列出。

`cleanTaskDirs` 不排除：评审的任务目录与该 Issue 的其他目录一起按 `WORKLING_KEEP_RUNS` 清理。

## 5. 控制台

### 5.1 设置

- 仓库详情页：在分诊级别旁增加「评审级别」选择（关闭 / 影子），写法照搬分诊级别。接口 `PUT /api/repos/:id/review`，请求体 `{ level: 'off' | 'shadow' }`，校验失败返回 400 `评审级别无效`；保存时同时更新 `reviewSince`。说明文案：`影子：每次交付后自动评审，只记录结论，不在 GitHub 上发评论或触发返工。`
- 设置页 codex 模型卡片：增加「评审模型」「评审强度」两个可选项，留空时的占位文案分别为 `与实现相同` 和 `high`。

### 5.2 Issue 详情页

- `GET /api/issues/:id/reviews`：返回该 Issue 的评审记录，按 `id` 降序。每项含 `id`、`status`、`verdict`、`summary`、`checks`、`acceptance`、`findings`（已解析为数组；库里为空或解析失败时返回空数组）、`error`、`model`、`effort`、`partial`、`headSha`、`runId`、`deliveryRunId`、`createdAt`、`endedAt`。
- 时间线里，评审运行显示为「评审」，与实现、返工区分；可以像其他运行一样打开执行日志。
- 评审运行所在的条目展示结论：
  - 状态与结论：排队中 / 评审中 / 通过 / 需修改 / 失败 / 已跳过（后两者显示原因）；
  - 总结；
  - 检查：每条命令及是否通过；
  - 验收：未满足（`no`）与无法确认（`unverified`）的条目及依据，已满足的只显示数量；
  - 发现：按严重度分组，每条显示位置（`path:line`，没有则不显示）、触发场景、说明；`known: true` 的标注「实现方已声明」。
- `skipped` 的评审没有运行记录，不在时间线里单独占一条；在 Issue 详情页不展示。
- 评审内容是模型输出，按纯文本渲染，不当作 HTML 或 Markdown 解释。

概览、任务列表、分诊页不改。

## 验收

- [ ] 迁移已生成；`reviews` 表、`repos.review_level`、`repos.review_since`、`pi_settings.review_model`、`pi_settings.review_effort` 存在，已有数据升级后 `review_level` 为 `off`。
- [ ] 对账测试：仓库为 `shadow`，实现运行交付成功后出现一条 `queued` 的评审，`headSha` 等于推送到远端的分支末端，`partial` 与交付结果一致；同一次交付对账重试不重复插入；仓库为 `off` 时不插入；答复运行不插入。
- [ ] 拉起测试（本地 bare Git，沿用 `test/serve-launch.test.ts` 的写法）：评审运行的工作副本检出在 `headSha`，分支名为 PR 分支；`spec.json` 的 `kind` 为 `review`、`repo.baseRef` 等于 PR base 分支与 `headSha` 的合并基点、`model.codex` / `model.effort` 取评审设置（未设置时为实现模型与 `high`）；`runs.kind` 为 `review` 且 `branch` 为空；Issue 的 `status`、`lastRunId` 与标签调用均无变化，没有任何 `gh issue comment` / `gh pr comment` 调用。
- [ ] 拉起测试覆盖四种跳过：级别已关闭、已有更新的交付、Issue 正在执行、PR head 已变化；跳过时不创建 `runs`、不占名额。
- [ ] 并发测试：`concurrency` 为 1、有一个进行中的评审时，`launchQueued` 不拉起新的实现任务；有一个 `running` 的 Issue 时，`launchReviews` 不拉起评审。
- [ ] 对账测试：评审运行产出合法 `out/review.json` → 评审为 `done`，各字段落库，`runs.endedAt` 已写；缺少或结构不符的 `review.json`、非零退出、进程丢失、超时 → 评审为 `failed` 并写明原因。
- [ ] 启动恢复测试：`running` 但没有进程句柄的评审被改回 `queued`。
- [ ] 回归测试：Issue 有一条更新的评审运行时，`runs.md` 不包含它；返工仍接续原工作分支；上游合并后下游变基仍被触发；概览与任务列表中该 Issue 的阶段和轮次不变。
- [ ] 接口测试：`PUT /api/repos/:id/review` 的合法与非法取值；`GET /api/issues/:id/reviews` 返回解析后的数组，库中 JSON 损坏时返回空数组而不是报错。
- [ ] `README.md` 与 `README.zh-CN.md` 增加一小节说明评审级别（影子）与评审模型设置。
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。

## 人工验收

- [ ] 把一个仓库的评审级别设为「影子」，让 workling 完成一个 Issue：PR 建好后控制台 Issue 详情页出现「评审」条目，结束后能看到结论与发现，GitHub 上没有新增评论或标签变化。
- [ ] 评审运行的执行日志页可以正常打开。

## 不做

- 不发 PR 评论、不改标签、不写 `feedback`、不触发返工（阶段 3、4）。
- 不做跨仓库的评审对照页；先在 Issue 详情页看，数据够了再决定要不要汇总页。
- `workling cancel` 不支持取消评审运行；评审只受超时控制。
- 不为评审运行发领取评论。
- 不回溯评审已有的 PR：只对级别打开之后的新交付排评审。
