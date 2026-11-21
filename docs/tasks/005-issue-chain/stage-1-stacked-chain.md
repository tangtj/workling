# 阶段 1：串行门控与堆叠分支

规则总览见 [README.md](README.md)。本阶段完成后，给主 Issue 打一次 `workling:ready`，子 Issue 就会按顺序逐个执行，每个子任务开一个以上一个子任务分支为 base 的 PR。

## 1. 读取父子关系：新建 `src/issue/chain.ts`

所有 GitHub 调用都走 `Command`（`gh api`），返回值用 typebox 校验后再使用。

```ts
export type SubIssue = {
  number: number
  title: string
  state: 'open' | 'closed'
  stateReason: string | null // 对应 state_reason：completed / not_planned / reopened / null
  sameRepo: boolean // repository_url 是否指向当前仓库
}

// GET repos/{path}/issues/{n}/sub_issues?per_page=100，保持返回顺序。
export async function readSubIssues(opts: {
  repo
  number: number
  command
  signal
}): Promise<SubIssue[]>

// GET repos/{path}/issues/{n}/parent；返回 404 时为 undefined，其他错误照常抛出。
export async function readParent(opts: {
  repo
  number: number
  command
  signal
}): Promise<{ number: number } | undefined>

// 在 subs 中找 number 的上一个兄弟，跳过 state === 'closed' && stateReason === 'not_planned' 的项。
// number 不在 subs 中，或前面没有兄弟时，返回 undefined。
export function previousSibling(subs: SubIssue[], number: number): SubIssue | undefined
```

- 判断 404：`gh api` 失败时 stderr 含 `HTTP 404`。按现有 `Command` 的错误形状判断，不要靠字符串以外的猜测；判断不了就照常抛出。
- `sameRepo`：比较 `repository_url` 是否以 `/repos/{repo.path}` 结尾（不区分大小写）。

## 2. 主 Issue 展开：`src/serve/poll.ts`

在 `pollOnce` 处理每个带 `workling:ready` 的 Issue 时，**先**调用 `readSubIssues`：

- 返回空数组：按现有逻辑入队，行为不变。
- 返回非空数组：视为主 Issue，**不**写入 `issues` 表。
  1. 对每个子 Issue，满足以下全部条件时，给它加 `workling:ready`（`gh issue edit <子号> --add-label workling:ready`）：
     - `sameRepo` 为 true，且 `state === 'open'`；
     - 库中没有对应记录，或记录的 `status` 为 `failed` / `canceled`。已经 `done`、`queued`、`running` 的跳过，避免重跑已完成的子任务。
  2. 主 Issue 去掉 `workling:ready`，加上 `workling:running`。
  3. 记日志：`#<主号> 主 Issue：展开 N 个子 Issue（#a #b …）`。
  4. 读取子 Issue 失败时记日志并跳过这个主 Issue，主 Issue 的 ready 标签保留，下轮重试。
- 子 Issue 在下一轮轮询中会被当作普通 ready Issue 正常入队，不需要特殊处理。

## 3. 串行门控：`src/serve/launch.ts` 的 `launchQueued`

对每个 queued 行，在 `slots--` **之前**做门控。不通过就 `continue`，不消耗并发名额，也不创建 run：

```ts
type Gate =
  | { kind: 'free' } // 没有父 Issue，或没有上一个兄弟，按现有逻辑
  | { kind: 'base' } // 上一个兄弟已合并或已关闭为完成，从文档或默认分支切出
  | {
      kind: 'stack'
      branch: string
      previous: number
      parent: number
      position: number
      total: number
    }
  | { kind: 'wait'; reason: string } // 留在 queued
  | { kind: 'error'; error: string } // 以错误结束本次运行
```

判定顺序：

1. `issue.prState === 'open'`（返工或在自己的分支上接着做）→ `free`，不门控。
2. `readParent` 为 undefined → `free`。
3. `readSubIssues(parent)`，取 `previousSibling`：
   - 没有上一个兄弟 → `free`；
   - 上一个兄弟 `sameRepo === false` → `error`：`不支持跨仓库的子 Issue（上一个是 …）`。
4. 查库中上一个兄弟的 `issues` 行及其 `lastRunId` 对应的 run：
   - `prState === 'merged'`，或 GitHub 上 `state === 'closed' && stateReason === 'completed'` → `base`；
   - `status === 'done'`、`prState === 'open'`、`run.reportResult` 以 `完成` 开头，且 `run.branch` 非空 → `stack`，branch 取 `run.branch`；
   - 其余情况（没有记录、queued、running、failed、canceled、部分完成、PR 已关闭但未合并）→ `wait`，reason 写明上一个兄弟的号和状态。
5. 读取父子关系的 GitHub 调用失败 → `wait`，并记日志。不要因为暂时的网络错误就把任务判为失败。

`wait` 只记日志：`#<号> 等待上一个子任务 #<上号>（<原因>）`。同样的原因不要每轮都重复刷日志：用内存 `Map<issueId, reason>` 去重，原因不变就不再打印。

`error` 的处理与 `prepareCheckout` 返回 `{ error }` 一致：写入 result，正常创建 run，由对账判为失败并评论。

## 4. 堆叠起点：`prepareCheckout`

新增入参 `stackOn?: { branch: string }`，仅在 `Gate.kind === 'stack'` 时传入：

- 起点 `start` 改为 `stackOn.branch`（必须是 `workling/` 开头的分支，且在镜像中存在，否则返回 `{ error: '上一个子任务的分支「…」不存在' }`）。
- 新任务分支名照旧用 `taskBranch(issue.number, issue.title)`。
- 正文里有 `分支：` 行时，照旧校验并把 `docBranch` 写入 spec，但**不**作为起点（上一个子任务的分支已包含文档分支的内容）。
- `baseRef` 照旧取起点的提交（即上一个子任务分支当前的 tip）。

## 5. 记录 PR base：表结构 + `land.ts`

- `runs` 新增可空列 `stack_branch`（`stackBranch: text('stack_branch')`），用 `bun run db:generate` 生成迁移。堆叠时写入上一个子任务的分支名，其他情况为 null。
- `src/serve/land.ts` 新建 PR 时：`--base` 取 `run.stackBranch ?? 默认分支`。已有 PR（返工）时不改 base。
- PR 正文末尾在堆叠时追加一行：`堆叠于 #<上一个子 Issue 号> 的分支 \`<branch>\`，请先审阅并合并上游 PR。`

## 6. 给执行方的上下文：`src/serve/context.ts`

`writeRunContext` 在堆叠或有父 Issue 时额外写出 `chain.md`（与 `docs.md` 同级），内容：

```md
# 子任务位置

- 主 Issue：#<父号> <父标题>
- 本任务：第 <k> / <N> 个子 Issue
- 上一个子任务：#<上号>，分支 `<branch>`（本任务从该分支切出） ← 仅 stack 时
- 上一个子任务已合并，本任务从 <起点> 切出 ← 仅 base 时

只实现本 Issue 的范围；上一个子任务的改动已经在分支里，不要重做或回退。
```

`Gate` 里需要的父标题、k、N 在门控时一并取得，经 `launchQueued` 传给 `writeRunContext`。

## 7. 主 Issue 标签汇总：`src/serve/reconcile.ts`

子任务落到终态、同步完自己的标签之后：

1. `readParent`；没有父 Issue 就结束。
2. `readSubIssues(parent)`，计算主 Issue 的目标标签：
   - 本子任务 `failed` / `canceled` → `workling:failed`；
   - 所有 `sameRepo` 的兄弟都满足「已合并」「已关闭为完成」或「库中为 `done` 且 `reportResult` 以 `完成` 开头」之一，`not_planned` 的不计入 → `workling:done`；
   - 否则 → `workling:running`。
3. 读取主 Issue 当前的标签，去掉其他 `workling:queued/running/done/failed`，加上目标标签。已经是目标标签就不调用。
4. 这一步失败只记日志，不影响子任务的终态（与现有「库是事实来源」的原则一致）。

## 验收

- [ ] `src/issue/chain.ts` 有单元测试（命令替身）：覆盖 sub_issues 顺序保持、parent 404 返回 undefined、`previousSibling` 跳过 not_planned、第一个子 Issue 返回 undefined。
- [ ] 轮询测试：带子 Issue 的 ready 主 Issue 不入库；open 且未完成的子 Issue 被加上 ready；已 done 的子 Issue 不加；主 Issue 标签从 ready 变为 running。
- [ ] 门控测试覆盖第 3 节每一条：free、base（已合并、关闭为完成）、stack、wait（running、failed、部分完成、无记录）、error（跨仓库）、读取失败时为 wait；wait 时不创建 run、不占 slots。
- [ ] 堆叠集成测试（本地 bare Git）：上一个子任务分支有提交 A，本子任务从该分支切出，`baseRef` 等于 A；落地后 `gh pr create` 的 `--base` 为上一个子任务的分支，PR 正文包含堆叠说明。
- [ ] 迁移已生成，`runs.stack_branch` 只在堆叠时写入。
- [ ] `chain.md` 在 stack 和 base 两种情况下内容正确；没有父 Issue 时不生成。
- [ ] 主 Issue 标签汇总：子任务失败 → failed；最后一个子任务完成 → done；中间子任务完成 → running。
- [ ] 无父 Issue 的普通 Issue 行为不变（现有测试全部通过）。
- [ ] [docs/workling.md](../../workling.md) 与 `templates/` 下的接入文档在「状态与返工」后新增「主 / 子 Issue」一节，说明：用 GitHub sub-issue 排顺序、给主 Issue 打 ready、堆叠 PR 要按顺序合并、部分完成和失败会让链条停下。
- [ ] `bun run check` 通过。

## 不做

- 上游合并后的变基与改 base（阶段 2）。
- Web 控制台展示链条（可另开 Issue）。
- 主 Issue 被重新打 ready 时取消正在运行的子任务。
