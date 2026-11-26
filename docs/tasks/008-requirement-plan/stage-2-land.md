# 阶段 2：主体触发、落地与展示

规则总览见 [README.md](README.md)。依赖阶段 1（[stage-1-worker-plan.md](stage-1-worker-plan.md)）的契约：`kind: 'plan'`、`out/plan.json`（`readPlan`）、`outcome: 'planned'`。本阶段不改 `worker/` 与 `src/contract/`。

做完后：需求 Issue 写上 `模式：拆解` 并打 ready，workling 推送设计文档、创建并挂好子 Issue、在需求 Issue 下评论；人重新打 ready 后子 Issue 按顺序执行。

## 1. 指令解析：`src/issue/branch.ts`

`docBranch` 里「跳过代码块与 HTML 注释、找到以某个前缀开头的第一行」的扫描逻辑抽成一个函数，`docBranch` 改为调用它，行为不变：

```ts
// 返回第一条不在代码块或 HTML 注释内、以「<name>：」开头的行冒号之后的内容（已 trim）；没有时返回 undefined。
export function findDirective(body: string, name: string): string | undefined
```

新增：

```ts
// 「模式：拆解」→ true；没有这一行 → false；值不是「拆解」→ { error: 'Issue 正文的「模式：」行只支持「拆解」' }。
export function planMode(body: string): boolean | { error: string }
```

## 2. 分诊：`src/serve/triage.ts`、`src/serve/triage-prompt.ts`

`checkIssue(body)`：

- `planMode` 返回 `{ error }` 时，把错误加入 `invalidDirectives`。
- `planMode` 为 `true` 时：必填节只有 `目标`（不要求 `验收`）；同时有 `分支：` 行时加入 `invalidDirectives`：`拆解需求不支持「分支：」行`。
- 其余情况行为不变。

`TRIAGE_PROMPT` 增加一句：正文含「模式：拆解」的是交给 workling 拆解的需求，目标清楚即可判为 accept，不要求范围与验收。

## 3. 设置：拆解模型与推理强度

新增两个设置 `planModel`（字符串或 null）、`planEffort`（`low` / `medium` / `high` / `xhigh` 或 null），存储、读取（`src/config/pi.ts` 的 `PiSettings`）、校验、设置接口（`src/web/routes/settings.ts`）与设置页展示**完全照搬** `reviewModel` / `reviewEffort` 的做法，放在设置页评审设置的旁边，标题「拆解」，说明文字：「拆解需求 Issue 时使用；未设置时用默认 codex 模型与 high。」表结构改动用 `bun run db:generate` 生成迁移。

## 4. 数据库：`src/db/schema.ts`

- `runs.kind` 的 enum 增加 `'plan'`。
- 新表 `plan_children`，记录拆解运行创建的子 Issue，用于创建过程的重入与控制台展示：

  ```ts
  export const planChildren = sqliteTable(
    'plan_children',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      runId: integer('run_id')
        .notNull()
        .references(() => runs.id, { onDelete: 'cascade' }),
      position: integer('position').notNull(), // 从 1 开始，对应 plan.children 的顺序
      number: integer('number').notNull(), // 子 Issue 编号
      githubId: integer('github_id').notNull(), // REST 返回的 id，挂子 Issue 时使用
      title: text('title').notNull(),
      linkedAt: integer('linked_at', { mode: 'timestamp' }),
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    },
    (table) => [uniqueIndex('plan_children_run_position_unique').on(table.runId, table.position)],
  )
  ```

用 `bun run db:generate` 生成迁移。

## 5. 是否允许拆解：`src/issue/chain.ts`

新增纯函数，拉起与重新拆解共用：

```ts
// 没有子 Issue，或全部子 Issue 都已关闭为「不计划」时允许（重新）拆解。
export function canPlan(subs: SubIssue[]): boolean
```

## 6. 轮询展开：`src/serve/poll.ts`

现有逻辑：打了 ready 的 Issue 只要有子 Issue 就展开。改为：`subs.length > 0 && !canPlan(subs)` 时才展开；全部子 Issue 都关闭为「不计划」时按普通 Issue 继续往下走（入队）。这样人把子 Issue 全部关闭为「不计划」再打 ready，就能重新拆解。其他情况的展开行为不变。

## 7. 拉起：`src/serve/launch.ts`

在 `readIssue` 取得正文之后、`prepareCheckout` 之前：

1. `kind === 'implement'` 时调用 `planMode(body)`：
   - `{ error }`：按 checkout 错误处理（写 `result.json` 的 `error`，本次运行失败），错误信息即该 error。
   - `true`：
     - 正文有 `分支：` 行 → 同样按 checkout 错误处理：`拆解需求不支持「分支：」行`。
     - 读取子 Issue（`readSubIssues`），`canPlan` 为假 → 按 checkout 错误处理：`已有未关闭或已完成的子 Issue，不再拆解；请直接编辑子 Issue，或把子 Issue 全部关闭为「不计划」后重试`。
     - 否则 `kind = 'plan'`，并更新 `runs.kind`。
2. `kind === 'plan'` 时：
   - `prepareCheckout` 与实现运行相同（检出需求 Issue 的任务分支；此前有拆解运行时接续其分支）。
   - `writeSpec` 的 `model`：`codex` 取 `pi.planModel ?? pi.model`，`effort` 取 `pi.planEffort ?? 'high'`。需求 Issue 正文的 `模型：`、`强度：` 行由 Pi 按约定覆盖，主体不处理。
   - 领取评论改为 `workling：已领取，开始拆解需求。`
   - `writeRunContext` 按 `implement` 的方式生成上下文。

查询「此前运行的分支」时已排除 `review`，`plan` 不需要排除（重新拆解要接续文档提交）。

## 8. 重新拆解的限制：`src/serve/rework.ts`

`queueRework` 对候选 Issue 的处理：最近一次运行的 `kind === 'plan'` 且本批反馈非空时，先读取子 Issue：

- `canPlan(subs)` 为真：照常入队（拉起时会再走第 7 节的判断）。
- 为假：不入队；把本批反馈的状态改为 `ignored`；在需求 Issue 下评论（用 `markComment`）：

  ```text
  workling：已经拆出子 Issue，不再重新拆解。要调整请直接编辑子 Issue；要整体重来，请把子 Issue 全部关闭为「不计划」，再评论 `/workling <说明>`。
  ```

  读取子 Issue 失败时跳过这个候选，下轮再试，不改反馈状态。

## 9. 落地：`src/serve/land.ts`

`landRun` 的 `run` 参数增加 `kind`。`kind === 'plan'` 时走下面的流程，其他类型不变。

### 9.1 读取与校验产出

1. `readOutResult`：
   - `answered`：与现在相同，返回 `{ status: 'answered' }`。
   - `planned`：继续；其他值 → `failed('拆解运行的结果无效：<outcome>')`。
2. `readPlan(out)`，失败 → `failed(<原因>)`（经 `redactSecrets`）。
3. 子 Issue 正文逐个校验，任一失败 → `failed('子 Issue <序号>（<标题>）格式无效：<原因>')`，原因为下列之一，多个用「、」连接：
   - `checkIssue(body)` 的 `missingSections` 非空：`缺少「<节名>」`；
   - `invalidDirectives` 非空：原样；
   - `findDirective(body, '分支') !== undefined`：`不能包含「分支：」行`；
   - `findDirective(body, '模式') !== undefined`：`不能包含「模式：」行`。
4. 对 `plan.summary`、全部子 Issue 的标题与正文、`out/issue-comment.md` 做密钥扫描（`findSecrets`，与 patch 扫描同一套规则），命中 → `failed('拆解产出命中密钥规则：…')`。

### 9.2 文档提交（`result.commits > 0`）

- bundle 的读取、导入与校验（分支命名空间、基点为祖先、禁止改工作流、patch 密钥扫描）与实现运行相同，复用现有代码，不复制。
- **只允许文档**：`git log -m --no-renames --format= --name-only -z <range>` 列出的路径必须全部匹配 `/\.(md|png|jpe?g|gif|svg|webp)$/i`，否则 → `failed('拆解运行只能提交文档：<路径，「、」连接，最多 10 个>')`。
- `plan.docs` 的每个路径都必须存在于分支末端：`git cat-file -e <tip>:<path>`，否则 → `failed('plan.json 列出的文档不存在：<路径>')`。
- 推送任务分支，方式与实现运行相同（含接续时的快进推送）。**不建 PR，不更新 PR。**

`result.commits === 0` 时：`plan.docs` 必须为空，否则 → `failed('没有文档提交，但 plan.json 列出了文档')`；不推送。

### 9.3 创建子 Issue

每个子 Issue 的最终正文：

```text
<plan 中的正文>

分支：<任务分支>                          ← 只在有文档提交时追加

<!-- workling:plan parent=#<需求 Issue 号> run=<运行 id> -->
```

追加后用 `docBranch(最终正文)` 复核：有文档提交时必须得到 `{ name: <任务分支> }`，没有时必须为 `undefined`；不符（例如正文末尾有未闭合的代码块）→ `failed('子 Issue <序号>（<标题>）的正文末尾有未闭合的代码块')`。这一步与 9.1 一起在创建任何子 Issue 之前完成。

按 `position` 从 1 开始依次处理，每个子 Issue：

1. `plan_children` 里没有 `(runId, position)` 的记录：`gh api -X POST repos/<path>/issues --input -`，请求体 `{ "title": ..., "body": ... }`，从响应里取 `number` 和 `id`（做形状校验），**立即**插入 `plan_children`。
2. 记录的 `linkedAt` 为空：`gh api -X POST repos/<path>/issues/<需求 Issue 号>/sub_issues --input -`，请求体 `{ "sub_issue_id": <githubId> }`；成功后写 `linkedAt`。响应为 422 且错误信息表明该子 Issue 已挂在这个父 Issue 下时，同样视为成功。

任一步 `gh` 调用失败时抛出异常，不返回 `failed`：沿用现有「落地遇到暂时错误时保留 running，下轮重试」与「持续对账失败转为终态」的机制。重试时已创建、已挂上的会被跳过；严格按顺序处理、失败即停，所以子 Issue 在父 Issue 下的顺序与 `plan.children` 一致。

已知窗口：`gh` 创建成功、插入 `plan_children` 之前进程退出，重试会再创建一个重复的子 Issue。窗口极短，不做额外处理，在代码注释中写明。

### 9.4 返回值

```ts
{ status: 'planned', branch: string | null, children: Array<{ number: number; title: string }> }
```

`branch` 在有文档提交时为任务分支，否则为 `null`。把它加入 `LandResult` 联合类型。

## 10. 对账：`src/serve/reconcile.ts`

调用 `landRun` 时传入 `run.kind`。`landed.status === 'planned'` 时：

- Issue 状态 `done`，`prUrl`、`prState` 保持为空；状态标签照常改为 `workling:done`。
- `runs.summary` 写 `plan.summary`（从任务目录重新读取 `out/plan.json`；读取失败时保留 `extractSummary` 的结果）。
- 不排评审（只有 `landed.status === 'done'` 的交付才排评审，确认现有条件已经保证这一点，并补测试）。
- 在需求 Issue 下发评论，沿用答复运行发布 `out/issue-comment.md` 的方式（`answerDir` 那条路径），正文末尾追加：

  ```text
  ### 子 Issue

  1. #<号> <标题>
  2. ...

  设计文档：<https://github.com/<path>/tree/<任务分支>>     ← 有文档提交时

  审阅文档与子 Issue 后，给本 Issue 重新打上 `workling:ready`，子 Issue 会按上面的顺序执行。要调整可以直接编辑子 Issue；要整体重新拆解，请把子 Issue 全部关闭为「不计划」，再评论 `/workling <说明>`。
  ```

## 11. 控制台

- 运行类型 `plan` 显示为「拆解」（任务列表、Issue 详情时间线、执行日志页等所有显示运行类型的地方）。
- Issue 详情页：拆解运行的时间线条目下列出 `plan_children` 中该运行创建的子 Issue（编号、标题、外链），未挂上的标注「未挂到父 Issue」。
- 概览「需要你处理」新增一类「拆解待确认」：最近一次运行 `kind === 'plan'`、Issue 状态为 `done`、该运行在 `plan_children` 里有记录的 Issue。人重新打 ready 后它会被展开、状态变为 `running`，自然退出这一类。

## 12. 接入文档与 Issue 模板

- `templates/repo/docs/workling.md` 与本仓库的 `docs/workling.md`（保留各自末尾的「本仓库约定」）：
  - 「选择方式」表格增加一行：**需求：交给 workling 拆解**——只知道要什么，设计和拆分交给 workling。
  - 新增一节「需求拆解」：正文只需 `## 目标`，可选 `## 背景`、`## 约束`、`## 不做`，单独一行 `模式：拆解`，不能有 `分支：` 行；打 ready 后的流程、放行方式、提问与重新拆解的方式（与第 8、10 节的评论内容一致）。
  - 「Issue 正文格式」后的指令说明加上 `模式：`。
  - 文件头的接入文档版本由 v1 改为 v2。
- 新增 `templates/repo/.github/ISSUE_TEMPLATE/workling-plan.md`（「workling 需求」，about：交给 workling 拆解的需求，写好后打上 workling:ready），正文为上述结构；本仓库 `.github/ISSUE_TEMPLATE/` 同步一份。
- `templates/SETUP.md` 列出新模板。
- `README.md` 与 `README.zh-CN.md` 的「使用」一节补一句 `模式：拆解` 的用法。

## 13. 测试

按 AGENTS.md：快速错误分支用命令替身，落地保留本地 bare Git。至少覆盖：

- `findDirective` / `planMode`：代码块与注释内的不算；值无效；`docBranch` 原有用例全部通过。
- `checkIssue`：拆解需求只要求 `目标`；`模式：拆解` 与 `分支：` 同时出现无效。
- `canPlan`：无子 Issue、全部不计划、有打开的、有已完成的。
- 轮询：全部子 Issue 不计划时不展开、正常入队；其余展开行为不变。
- 拉起：`模式：拆解` 得到 `kind: 'plan'` 与拆解模型 / 强度；有打开的子 Issue 时失败并给出原因；`模式：` 值无效时失败。
- 返工排队：拆解 Issue 有打开的子 Issue 时不入队、反馈改为 `ignored`、发评论；全部不计划时入队。
- 落地：
  - 有文档提交：推送分支、不建 PR、按顺序创建并挂上子 Issue、正文带 `分支：` 行与来源标记；
  - 没有文档提交：不推送、正文不带 `分支：` 行；
  - 提交了非文档文件、`plan.docs` 路径不存在、子 Issue 缺少「验收」、子 Issue 带 `分支：` 行、产出命中密钥 → 失败且没有创建任何子 Issue；
  - 第 2 个子 Issue 创建失败 → 抛出；重试时不重复创建第 1 个，按顺序继续；
  - 挂子 Issue 返回「已挂上」的 422 → 视为成功。
- 对账：`planned` → 状态 `done`、标签 `workling:done`、评论含子 Issue 列表与放行说明、不排评审。
