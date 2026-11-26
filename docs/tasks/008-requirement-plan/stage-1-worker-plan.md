# 阶段 1：契约与 worker 的拆解运行

规则总览见 [README.md](README.md)。本阶段只改 `src/contract/`、`worker/`、对应测试与 README 的「单独运行 worker」一节，**不改主体**（`src/serve/`、`src/web/`、`src/db/`、`src/issue/`）。做完后，不启动主体就能对一个准备好的运行目录跑出设计文档和子 Issue 清单。

## 1. 契约：`src/contract/`

### 1.1 `spec.json`

`specSchema.kind` 增加 `'plan'`：

```ts
kind: Type.Union([
  Type.Literal('implement'),
  Type.Literal('rework'),
  Type.Literal('review'),
  Type.Literal('plan'),
])
```

拆解运行里各字段的含义：

| 字段             | 含义                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `repo.branch`    | 需求 Issue 的任务分支（`workling/<号>-<短名>`），工作副本已检出到它      |
| `repo.baseRef`   | 与实现运行相同：分支基点；`continued` 为真时是此前拆解运行留下的分支末端 |
| `repo.continued` | 与实现运行相同：接续此前运行的分支（重新拆解时，已有的文档提交在分支上） |
| `repo.docBranch` | 不使用                                                                   |
| `model.codex`    | 拆解使用的 codex 模型                                                    |
| `model.effort`   | 拆解使用的推理强度                                                       |
| `model.pi`       | 与实现运行相同，可选                                                     |

**`CONTRACT_VERSION` 不变（仍为 2）**，理由与评审相同：原有类型的字段和语义没有变化，旧 worker 收到 `kind: 'plan'` 时因 `spec.json 的结构无效` 失败，只影响这一次拆解。更新 `CONTRACT_VERSION` 旁的注释，把「评审」改为「评审与拆解」。

### 1.2 `out/plan.json`

新建 `src/contract/plan.ts`（与 `review.ts` 同样的组织方式），并在 `src/contract/out.ts` 中 re-export：

```ts
export const planSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  docs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 }),
  children: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      body: Type.String({ minLength: 1, maxLength: 60_000 }),
    }),
    { minItems: 1, maxItems: 10 },
  ),
})
export type Plan = Type.Static<typeof planSchema>

// 读取 out/plan.json：缺失时抛出「缺少 out/plan.json」，JSON 无效或结构不符时分别抛出明确错误。
export async function readPlan(dir: string): Promise<Plan>
```

- `readPlan` 用 `readOutputFile` 读取，上限 1 MiB，错误写法与 `readReview` 一致。
- `summary`：两三句，说明拆成几步、每步的主题、最主要的风险。主体会把它放进需求 Issue 下的评论。
- `docs`：本次运行提交的设计文档路径（相对仓库根目录，正斜杠）。没有文档提交时为空数组。
- `children`：按执行顺序排列的子 Issue。`body` 是完整的 Issue 正文（格式见第 2.1 节），**不含** `分支：` 行，主体会统一加上。

### 1.3 `out/outcome.json` 与 `out/result.json`

- `piOutcomeSchema.outcome` 增加 `'planned'`。
- `out.ts` 中的 `TaskOutcome` 同时排除 `'reviewed'` 和 `'planned'`（`report.md` 推断不会得出这两个值）。
- 拆解运行可能的结果只有两个：`planned`（产出了 `plan.json`）和 `answered`（需求不清，提问）。

## 2. worker

### 2.1 拆解约定：新建 `worker/configs/PLAN.md`

拆解运行使用这份约定，不使用 `AGENTS.md`。`worker/task.ts` 在 `spec.kind === 'plan'` 时把 `--append-system-prompt` 的参数换成它。用中文写，结构与措辞风格参照 `worker/configs/AGENTS.md` 和 `worker/configs/REVIEW.md`。内容要点：

**角色**：你负责把需求拆成可以按顺序交给 workling 实现的子 Issue，并写出它们共同依据的设计文档。你调用 codex 调研仓库和起草，自己核对、提交文档、写产出；**不写业务代码**，不修改文档以外的文件。

**步骤**：

1. 读取：`<任务目录>/input/issue.md`，以及 `input/runs.md`、`input/branch.md`、`input/docs.md`（存在则读）。讨论区里以 `/workling` 或 `@token 账号` 开头、或提及机器账号的评论是补充说明，与正文冲突时以最新的为准。接续此前运行时，分支上已有的文档提交是上一轮的成果，在其基础上修改。
2. 仓库约定：读仓库的 `AGENTS.md`、`README`、`docs/workling.md`（存在则读）。从 `docs/workling.md` 末尾「本仓库约定」中取文档目录与编号规则；没有约定时文档写到 `docs/workling/<Issue 号>-<短名>/`。
3. 判断能否拆解：需求的目标有多种理解、且不同理解会得出不同的设计时，**不要猜**，改为提问：把最多 5 个问题写到 `<任务目录>/out/issue-comment.md`（每个问题说明为什么需要回答、各个选项会怎样影响设计），`out/outcome.json` 写 `{"outcome":"answered"}`，不提交，跳过后续步骤。只是细节未定、能按仓库现有做法推断的，不算需求不清，在设计文档里写明所做的选择即可。
4. 调研与起草：写 `<任务目录>/codex-input.md` 并调用 codex（调用方式与 `AGENTS.md` 第 5 步相同：模型与强度默认用用户消息给出的拆解模型与强度，需求 Issue 正文有 `模型：` / `强度：` 行时用其值；沙箱模式用用户消息给出的值）。输入包含：
   - 需求 Issue 正文与讨论（原样）；
   - 第 2 步得到的文档目录；
   - 下方「设计文档要求」与「子 Issue 要求」；
   - 约束：只在文档目录内创建或修改文件；不修改任何其他文件；不执行 git 写操作；不联网；把子 Issue 草稿写到 `<任务目录>/plan-draft.md`，每个子 Issue 一节，含标题和完整正文。
5. 核对：
   - `git status` 确认只有文档目录内的 `.md` 和图片文件有变化，其他变化一律还原，并在总结中说明。
   - 逐个检查子 Issue 草稿：符合「子 Issue 要求」；正文能独立读懂；「文档」一节列出的路径都存在；没有 `分支：` 行和 `模式：` 行。不符合的自己改正（子 Issue 正文和设计文档由你负责，可以直接修改）。
   - 检查设计文档写明了「受影响的已有功能」，且每一项都落到了某个子 Issue 的「验收」里。
6. 交付：
   - 有文档变化时，在当前任务分支上本地提交，提交信息按仓库规范；没有规范时写 `<Issue 标题>：设计文档 (#<号>)`。署名规则与 `AGENTS.md` 第 7 步相同。
   - 写 `<任务目录>/out/plan.json`（结构见契约）和 `<任务目录>/out/outcome.json`：`{"outcome":"planned"}`。
   - 写 `<任务目录>/out/issue-comment.md`：拆解思路、每个子 Issue 一句话说明、需要人重点确认的取舍。最多 60000 字符。子 Issue 链接由主体补充，不要自己写编号。

**设计文档要求**：

- 入口文档 `README.md`：目标（含为什么）、现状（相关模块、调用关系、已有约定）、方案、已定的规则、**受影响的已有功能**（每一项说明新改动下它如何保持原约定、由哪个子 Issue 的哪条验收保证）、分阶段表（与子 Issue 一一对应）、不做。
- 内容较多的阶段另写 `stage-<n>-<短名>.md`，写到实现无歧义：改哪些文件、函数与字段签名、边界条件、错误信息。入口文档的分阶段表链接到它们。
- 只写依据仓库实际代码得出的内容，引用的文件、函数、字段必须真实存在；拿不准的写成「待定」并说明影响，不要编造。

**子 Issue 要求**：

- 数量 1 – 10 个。需求本身就小的，拆成 1 个也可以。
- 按执行顺序排列；后一个可以依赖前一个，不能依赖后面的。每一个合入后系统完整可用，不留半成品开关。
- 每一个的范围是一次 PR 能审完的量：集中在一个子系统，避免同时改动大量文件。
- 正文按 Issue 格式写（`## 目标`、`## 范围`、`## 验收`、可选 `## 人工验收`、`## 不做`、有文档时 `## 文档`），要能独立读懂，不写「见上一个子任务」这类依赖上下文的话。
- 「验收」只写能用命令、测试、文件内容核对的项，包括受影响的已有功能的回归检查；页面视觉、浏览器交互、真实环境确认写进「人工验收」。
- 「不做」列出属于其他子 Issue 的内容，防止越界。
- 可以写 `模型：`、`强度：` 行为个别子 Issue 指定模型；不写 `分支：` 和 `模式：` 行。

**禁止**：修改文档目录以外的文件；修改业务代码；运行 `git push` 或修改 remote；运行 `gh`；在产出中输出任何 token。

### 2.2 `worker/task.ts`：拉起

`spec.kind === 'plan'` 时：

- `--append-system-prompt` 用 `worker/configs/PLAN.md`。
- 用户消息改为下面的内容：

  ```text
  Issue：https://github.com/<project>/issues/<iid>（<issueRef>）
  仓库目录：<repo>
  任务分支：<spec.repo.branch>（已检出，<branchStatus>）
  运行类型：plan
  任务目录：<dir>
  Issue 内容：<issuePath>
  上下文：<dir>/input/runs.md、branch.md、docs.md（workling 生成：历次运行、工作分支、文档清单）
  拆解用 codex 模型：<spec.model.codex>
  拆解用 codex 推理强度：<spec.model.effort>
  codex 沙箱模式：<沙箱模式>
  按系统提示中的拆解约定拆解这个需求。
  ```

  `<branchStatus>` 与实现运行的写法相同；沙箱模式与实现运行相同（codex 要写文档）。

- 拉起前删除 `out/result.json` 与 `out/plan.json`（与评审删除旧产出的理由相同：单独运行时目录可复用）。

### 2.3 `worker/task.ts`：收尾

Pi 退出后，`spec.kind === 'plan'` 时：

1. 提交数、分支末端的计算与实现运行相同。
2. `outcome` 只从 `readPiOutcome` 读取，**不回退到 `report.md` 推断**。缺失时返回错误 `拆解运行缺少 out/outcome.json`；不是 `planned` 或 `answered` 时返回错误 `拆解运行的结果无效：<outcome>`。
3. `planned`：调用 `readPlan(outDir)` 校验；有提交时生成 `out/commits.bundle`（与实现运行相同的范围），没有提交时删除它。
4. `answered`：与实现运行相同（不生成 bundle）。
5. 写 `out/result.json`，字段与实现运行相同，`outcome` 为上述值。

以上任一步失败，返回 `生成拆解产出失败：<原因>`（原因经 `redact` 处理），与现有 `生成任务产出失败` 写法一致。worker 只校验结构；文件范围、子 Issue 格式等内容校验由主体落地时完成（阶段 2）。

实现、返工、评审运行的行为不变。

### 2.4 样例：`worker/samples/plan-notes`

`worker/samples.ts` 已支持按 `kind` 准备样例；`plan` 样例与 `implement` 样例结构相同（`repo/`、`input/issue.md`、`sample.json`，不能有 `change/`），确认现有校验对 `plan` 生效，必要时只补测试。

样例内容：

- `repo/`：一个最小的 TypeScript 包，结构仿照 `worker/samples/add-function/repo`，README 写明安装与检查命令，另有 `docs/workling.md`，其「本仓库约定」写明文档目录 `docs/tasks/<NNN>-<短名>/`。包含：
  - `src/notes.ts`：内存中的笔记库，`addNote(text)`、`listNotes()`、`removeNote(id)`；
  - `src/storage.ts`：`exportNotes(): string`（JSON）与 `importNotes(json: string)`；
  - 对应测试。
- `input/issue.md`：一个粗需求，只有 `## 目标`（给笔记加标签，并能按标签筛选列表）和 `## 背景`（两三句），以及一行 `模式：拆解`。不写范围和验收。
- `sample.json`：`kind: "plan"`，`issue.ref` 为 `github:example/notes#3`，`branch` 为 `workling/3-tags`，模型字段仿照现有样例。

预期结论（写进样例目录的 `README.md`，供人工比对，不做自动断言）：

- `out/plan.json` 有 2 – 3 个子 Issue（例如：数据结构与增删标签 → 按标签筛选 → 导出导入保留标签）。
- 设计文档写在 `docs/tasks/001-<短名>/`，「受影响的已有功能」中有导出 / 导入：旧格式（没有标签字段）的 JSON 仍能导入。
- 有一个子 Issue 的「验收」包含导入旧格式 JSON 的回归检查。
- 子 Issue 正文中没有 `分支：` 行。

### 2.5 测试

用 Pi 命令替身覆盖第 2.3 节的分支：`planned` 有提交 / 无提交、`answered`、缺少 `outcome.json`、结果为 `completed`、`plan.json` 结构无效。断言 `out/result.json`、`commits.bundle` 是否存在与返回的错误信息。

### 2.6 文档

`README.md` 与 `README.zh-CN.md` 的「单独运行 worker」一节补一句：`plan-notes` 是拆解样例，产出在 `out/plan.json` 与任务分支上的文档提交。
