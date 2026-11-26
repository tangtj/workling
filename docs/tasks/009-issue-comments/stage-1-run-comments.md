# 阶段 1：运行评论改版

背景与整体规则见 [README.md](README.md)。本阶段只改 Issue 下由运行产生的评论（领取、交付、答复、拆解、失败）和 Pi 的写作约定。

## 1. 外框

所有运行评论用同一个外框，在 `src/serve/comment.ts` 新增纯函数：

```ts
export function runComment(parts: {
  title: string // 标题文字，不含 "### "
  facts: string[] // 事实行的各项；空数组时省略事实行
  body?: string // AI 写的正文，已整理；空或缺省时省略
  tail?: string // workling 生成的固定内容（验收勾选、子 Issue 列表等）；缺省时省略
  next?: string // 下一步；缺省时省略
}): string
```

输出（各部分之间空一行，省略的部分连同空行一起省略）：

```md
### <title>

<facts 用 " · " 连接>

<body>

<tail>

**下一步**：<next>
```

- 只有 `body` 参与截断：整条评论超过 `maxCommentLength`（`src/contract/out.ts`）时截短 `body`，末尾加 `\n\n（已截断）`，不截断代理对；外框、`tail`、`next` 保持完整。
- `runComment` 不做脱敏、提及处理和 `markComment`，由调用方按现有顺序处理整条文本：`markComment(neutralizeMentions(redactSecrets(text, secrets)))`。
- 评论不再以 `workling：` 开头。

### 标题

格式：`<图标> 第 <N> 轮 · <类型> · <状态>`。

- **轮次 N**：该 Issue 下 `kind` 不是 `review` 的运行，按 `id` 升序排，当前运行的序号（从 1 开始）。在 `src/serve/comment.ts` 提供 `runRound(db, issueId, runId): number`。
- **类型**：`implement` → `实现`，`rework` → `返工`，`plan` → `拆解`。
- **图标与状态**见各评论的规定。

### 事实项的写法

- 用时：结束时间减开始时间，向上取整到分钟，最少 1 分钟。不足 60 分钟写 `用时 24 分钟`，否则写 `用时 13 小时 37 分钟`（分钟为 0 时写 `用时 2 小时`）。提供 `formatDuration(startedAt, endedAt): string`。
- PR：`prUrl` 以 `/pull/<数字>` 结尾时写 `[PR #<数字>](<prUrl>)`，否则原样写 `prUrl`。
- 运行编号：`运行 #<run.id>`，总是放在事实行最后。
- 由谁实现：`runs.executor` 为 `pi` → `Pi 实现`，`codex` → `codex 实现`，`mixed` → `Pi + codex 实现`，为空时省略。

评论中不再出现机器名（`settings.worker`）、任务目录和 ISO 时间戳。

## 2. 正文整理

在 `src/serve/comment.ts` 新增 `normalizeBody(text: string): string`，只改格式：

1. 去掉首尾空白。
2. 正文开头是 `交付结果：<完成|部分完成|未完成>` 或 `结果：<…>`（冒号全角或半角，后面可跟一个 `。` 或 `.` 及空白）时，去掉这一段前缀，保留同一行后面的文字。只处理正文最开头的一处。
3. 围栏代码块（以 ` ``` ` 或 `~~~` 开头的行之间）以外的 ATX 标题行（`^ {0,3}#{1,6}[ \t]+文字`，去掉行尾的 `#`）改为 `**文字**`。文字本身已被 `**` 包住时不重复包。
4. 连续 3 个及以上的换行压成 2 个（代码块内不动）。

`normalizeBody` 不删除、不改写、不重排任何内容，也不处理 `<details>`。所有运行评论里来自 `out/issue-comment.md` 的文字都先经过它。

## 3. 各评论

下面的 `N`、`类型` 按第 1 节取值。

### 3.1 领取（`src/serve/launch.ts`）

```md
### ▶️ 第 2 轮 · 返工 · 开始

分支 `workling/126-plan-land` · 运行 #412

**触发反馈**

- Issue 评论 · @someone · https://…
```

- 标题状态固定为 `开始`。
- 事实：`分支 \`<runs.branch>\``（发评论时读该运行的 `branch`，为空则省略）、运行编号。
- 有触发反馈时把现有的列表放进 `tail`，标题由 `触发反馈：` 改为 `**触发反馈**`，条目格式与「等 N 条」不变。
- 没有 `body` 和 `next`。提及处理与现在一致（这条评论不经过 `neutralizeMentions`）。

### 3.2 交付（`publishIssueResult`，`src/serve/land.ts`）

```md
### ✅ 第 1 轮 · 实现 · 完成

[PR #128](https://…/pull/128) · 新建 · 1 个提交 · 用时 24 分钟 · codex 实现 · 运行 #410

<正文>

**验收勾选**：勾选 5 项

<details><summary>逐项依据</summary>

- ☑ `bun run check` 通过。
  - 依据：724 pass、0 fail、1 skip。
- 跳过：<条目文字>（找不到原文行）

</details>

**下一步**：评审并合并 PR。需要修改时在 PR 或本 Issue 评论 `/workling <说明>`。
```

- 标题：`landed.partial` 为假 → `✅ … · 完成`；为真 → `🟡 … · 部分完成`。
- 事实依次为：PR、`新建`（`landed.created`）或 `更新`、`<landed.commits> 个提交`、用时、由谁实现、运行编号。
- `body`：`normalizeBody(out/issue-comment.md)`；文件为空或不存在时省略。
- `next`：
  - 完成：`评审并合并 PR。需要修改时在 PR 或本 Issue 评论 \`/workling <说明>\`。`
  - 部分完成：`PR 为草稿。要继续时评论 \`/workling <补充说明>\`，或把剩余部分另开 Issue。`
- `publishIssueResult` 需要的运行信息（运行 id、类型、开始与结束时间、`executor`、轮次）由 `reconcile` 传入；参数怎么组织由实现决定。

**待办并入**：不再单独发「即将更新 Issue 待办」。新的顺序：

1. 读 `out/issue-comment.md`。
2. 读 `out/checklist.json`；有条目时读 Issue 正文并 `planChecklist`。这一步任何环节失败都只记日志（沿用现有的步骤名），按「没有待办变更」继续。
3. 组装并发送这一条交付评论。`changes` 非空时带上「验收勾选」的 `tail`。
4. 评论发送成功且 `changes` 非空时，重新读取 Issue 正文、`applyChecklist`、更新正文（与现在相同）。评论发送失败时不修改正文，保持「先评论、后修改」。

「验收勾选」的格式：

- 首行 `**验收勾选**：勾选 <a> 项`；有取消勾选的追加 `，取消 <b> 项`；有跳过的追加 `，跳过 <c> 项`。a 为 0 时省略「勾选 0 项」这一段，以后面的段开头。
- 明细放在 `<details><summary>逐项依据</summary>` 里，`<details>` 行后与 `</details>` 行前各空一行。
- 每个变更一条：勾选写 `- ☑ <条目文字>`，取消勾选写 `- ☐ <条目文字>（取消勾选）`，下一行 `  - 依据：<evidence>`。
- 跳过的写 `- 跳过：<条目文字>（<原因>）`，原因文案沿用现有的三种。
- 条目文字：`line` 去掉开头的列表符号与复选框（`^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*`）。`evidence` 中的连续空白（含换行）压成一个空格。
- 用 `☑` / `☐` 而不是 `- [x]`，避免评论里出现可点击的任务项。

### 3.3 答复（`src/serve/reconcile.ts`）

```md
### 💬 第 3 轮 · 答复

用时 4 分钟 · 运行 #415

<正文>

**下一步**：还有问题或需要改代码时评论 `/workling <说明>`。
```

- 标题没有类型段，固定为 `💬 第 <N> 轮 · 答复`。
- `body`：`normalizeBody(说明)`；没有说明时为 `（Pi 未写说明）`。

### 3.4 拆解完成（`src/serve/reconcile.ts`）

```md
### 🧩 第 1 轮 · 拆解 · 完成

2 个子 Issue · 用时 18 分钟 · 运行 #409

<正文>

**子 Issue**

1. #125 需求拆解 1/2：契约与 worker 的拆解运行
2. #126 需求拆解 2/2：主体触发、落地与展示

设计文档：<https://…/tree/workling/124-requirement-plan>

**下一步**：审阅文档与子 Issue 后，给本 Issue 重新打上 `workling:ready`，子 Issue 会按上面的顺序执行。要调整可以直接编辑子 Issue；要整体重新拆解，请把子 Issue 全部关闭为「不计划」，再评论 `/workling <说明>`。
```

- `body`：`normalizeBody` 处理「拆解摘要 + 空行 + 说明」（两者有哪个写哪个）。
- `tail`：`**子 Issue**`、列表、设计文档行（没有分支时省略），内容与现在相同，只把 `### 子 Issue` 改成加粗。
- 现有针对这条评论的手工截断逻辑改为使用 `runComment` 的截断。

### 3.5 未完成（`src/serve/reconcile.ts`）

```md
### ❌ 第 2 轮 · 实现 · 未完成

用时 2 分钟 · 运行 #411

**原因**：进程丢失

<Pi 的说明>

<details><summary>回报摘录</summary>

> …

</details>

**下一步**：重新打上 `workling:ready`，或评论 `/workling <补充说明>` 重试。
```

- 标题状态：一般失败为 `未完成`；对账持续失败（`sustainedFailure`）为 `对账失败，已停止重试`。没有运行记录时标题为 `❌ 执行未完成`，事实行省略。
- `body`：`**原因**：<error>`，有 Pi 的说明时空一行后接 `normalizeBody(说明)`。不再有 `### Pi 的说明` 标题。
- `tail`：有回报摘录时放进 `<details><summary>回报摘录</summary>`，内容仍是现有的引用块。

## 4. Pi 的写作约定

### 4.1 `worker/configs/AGENTS.md`

把第 10 步「回复」的第一条（「把结果说明写到 `<任务目录>/out/issue-comment.md` …最多 60000 字符。」）整条替换为下面的内容；后两条关于任务清单与 `checklist.json` 的规定不变。

````md
- 把本轮说明写到 `<任务目录>/out/issue-comment.md`。workling 会把它放进一条评论：评论的标题行（轮次、类型、交付结果）、PR 链接、提交数、用时和「下一步」由 workling 生成，你只写中间的正文。写什么、写多少由你按本轮情况决定，遵守下面的方向：
  - **读者**是没看过代码的评审者。开头用一两句话说清这一轮做成了什么；部分完成或没有本地提交时，先说缺什么、为什么。
  - **不写外框里已有的信息**：交付结果、PR 链接、提交号、用时、如何重试或继续。
  - **小节可选**，没有内容就不写；要写时只用下面的名字、按这个顺序，标题写成单独一行的加粗（如 `**检查**`），不用 `#` 标题：
    - `**改动**`：按行为写，不按文件罗列，最多 5 条。你自己改过仓库文件时，其中一条说明类别（解决冲突 / 自己实现 / 修补小缺口）。
    - `**检查**`：只写你亲自确认过的，每条命令一行，写成「`命令`：结果」。
    - `**未完成与存疑**`：部分完成时逐条列出未满足的验收项；没有本地提交时引用 `report.md` 的未完成说明，没有 `report.md` 时说明 codex 的失败情况。
    - `**待人工验收**`：Issue 有「人工验收」一节时，原样列出该节条目并保持未勾选；没有该节时省略。
  - **简单任务可以只写一两句话**，不必硬凑小节。
  - **长度**：`**待人工验收**` 之外的部分不超过 15 行。还有值得保留的细节时放进 `<details><summary>细节</summary>` … `</details>`。整份最多 60000 字符。

  范例（简单任务）：

  ```md
  分诊现在跳过带子 Issue 的主 Issue，并摘掉误打的 `workling:needs-info`；普通 Issue 不受影响。

  **检查**

  - `bun run check`：634 通过，1 跳过（没有 Docker）。
  ```

  范例（部分完成）：

  ```md
  评审排队、调度和控制台展示已完成；启动恢复没有做，重启后进行中的评审会停在运行中。

  **改动**

  - 交付成功时在同一事务里排一次评审。
  - 评审运行与实现任务共用并发名额。
  - Issue 详情页展示评审结论。

  **检查**

  - `bun run check`：682 通过，1 跳过（没有 Docker）。

  **未完成与存疑**

  - 「重启后恢复进行中的评审」未实现：需要先确定评审运行的超时规则。

  **待人工验收**

  - [ ] 评审运行的执行日志页可以正常打开。
  ```
````

写入 `AGENTS.md` 时按文件现有的缩进排版。

同一文件里其他提到 `out/issue-comment.md` 的地方（第 1 步「答复」、第 4 步「放弃」）各补一句：格式遵循第 10 步的方向，不用 `#` 标题。

### 4.2 `worker/configs/PLAN.md`

提问（第 3 步）和拆解说明（写 `out/issue-comment.md` 的那一条）各补一句：小节标题写成单独一行的加粗，不用 `#` 标题；不写子 Issue 编号、链接和下一步操作，这些由 workling 补充。

## 5. 文档

`docs/workling.md` 与 `templates/repo/docs/workling.md` 中「状态与返工」的这一条：

> 领取时 workling 会在 Issue 下评论；运行中亲自确认的待办项会勾选，修改勾选状态前先评论说明。

改为：

> 每轮开始和结束时 workling 会在 Issue 下评论，结束时的评论写明轮次、结果和下一步；运行中亲自确认的待办项会勾选，依据写在这条评论里。

只改这一句，不改版本标记。

## 6. 测试

用例名说明场景和行为，沿用现有的命令替身写法。

`test/serve-comment.test.ts`：

- `runComment`：各部分齐全时的完整输出；`facts` 为空、`body` / `tail` / `next` 缺省时对应部分和空行一起省略。
- `runComment`：`body` 超长时整条不超过 `maxCommentLength`，`tail` 与 `next` 完整保留，正文以 `（已截断）` 结尾。
- `normalizeBody`：`##` / `###` 标题变为加粗；代码块内的 `#` 行不动；开头的 `交付结果：完成。` 前缀被去掉而同一行后面的文字保留；正文中间出现的「交付结果：」不动；多余空行被压缩；已是加粗的标题文字不重复包。
- `formatDuration`：不足 1 分钟、59 分钟、整小时、13 小时 37 分钟。
- `runRound`：评审运行不计入轮次。

更新现有断言：

- `test/serve-launch.test.ts`：领取评论为新格式，不含机器名、任务目录和时间戳；返工时带「触发反馈」。
- `test/serve-land.test.ts`：交付评论为新格式（完成与部分完成各一例）；有待办变更时只发一条评论、其中含「验收勾选」，且评论先于正文更新；评论发送失败时不更新正文；读取待办失败时仍发交付评论。原有的脱敏、提及处理、超长截断用例保持通过。
- `test/serve-reconcile.test.ts`：答复、未完成（含没有运行记录、对账持续失败）为新格式。
- `test/serve-plan.test.ts`：拆解完成评论为新格式，子 Issue 列表与下一步完整。
- `test/task.test.ts` 等引用 `worker/configs/AGENTS.md` 文案的断言按新文案更新。

## 7. 验收

- 第 1–5 节的规定全部满足，第 6 节列出的场景都有用例。
- `src/` 中不再有以 `workling：已领取`、`workling：已创建 PR`、`workling：已更新 PR`、`workling：即将更新 Issue 待办`、`workling：已答复`、`workling：已完成拆解`、`workling：执行未完成`、`workling：对账持续失败` 开头的评论文案。
- 分诊评论、`src/serve/pr-sync.ts`、`src/serve/rework.ts`、`src/serve/replies.ts` 发出的评论文案不变。
- `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
