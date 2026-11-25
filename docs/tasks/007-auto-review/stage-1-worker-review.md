# 阶段 1：契约与 worker 的评审运行

规则总览见 [README.md](README.md)。本阶段只改 `src/contract/`、`worker/` 和对应测试，**不改主体的调度**（`src/serve/`、`src/web/`、`src/db/`）。做完后，不启动主体就能对一个准备好的运行目录跑出评审结论。

## 1. 契约：`src/contract/`

### 1.1 `spec.json`

`specSchema.kind` 增加 `'review'`：

```ts
kind: Type.Union([Type.Literal('implement'), Type.Literal('rework'), Type.Literal('review')])
```

评审运行里各字段的含义：

| 字段             | 含义                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `repo.branch`    | PR 的 head 分支，工作副本已检出到它                               |
| `repo.baseRef`   | 评审范围的起点提交（PR head 与 PR base 分支的合并基点），完整 oid |
| `repo.docBranch` | 与实现运行相同，可选                                              |
| `repo.continued` | 不使用                                                            |
| `model.codex`    | 评审使用的 codex 模型                                             |
| `model.effort`   | 评审使用的推理强度                                                |
| `model.pi`       | 与实现运行相同，可选                                              |

评审范围就是 `git diff <repo.baseRef> HEAD`。

**`CONTRACT_VERSION` 不变（仍为 2）**。原有两种类型的字段和语义没有变化；旧 worker 收到 `kind: 'review'` 时会因 `spec.json 的结构无效` 失败，这次评审记为失败，不影响实现与返工。在 `CONTRACT_VERSION` 旁用注释写明这一点。

### 1.2 `out/review.json`

在 `src/contract/out.ts` 新增 schema、类型与读取函数：

```ts
export const reviewSchema = Type.Object({
  verdict: Type.Union([Type.Literal('pass'), Type.Literal('changes')]),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  checks: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 500 }),
      passed: Type.Boolean(),
      detail: Type.String({ maxLength: 2000 }),
    }),
    { maxItems: 20 },
  ),
  acceptance: Type.Array(
    Type.Object({
      item: Type.String({ minLength: 1, maxLength: 500 }),
      met: Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('unverified')]),
      evidence: Type.String({ maxLength: 1000 }),
    }),
    { maxItems: 50 },
  ),
  findings: Type.Array(
    Type.Object({
      severity: Type.Union([Type.Literal('blocker'), Type.Literal('major'), Type.Literal('minor')]),
      path: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
      line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      scenario: Type.String({ minLength: 1, maxLength: 2000 }),
      body: Type.String({ minLength: 1, maxLength: 4000 }),
      known: Type.Boolean(),
    }),
    { maxItems: 30 },
  ),
})
export type Review = Type.Static<typeof reviewSchema>

// 读取 out/review.json：缺失时抛出「缺少 out/review.json」，JSON 无效或结构不符时分别抛出明确错误。
export async function readReview(dir: string): Promise<Review>
```

- `readReview` 用现有的 `readOutputFile` 读取，上限 1 MiB，错误信息的写法与 `readReplies` 一致。与 `readReplies` 不同的是：文件缺失也抛出错误，不返回空值。
- `checks`：评审方**亲自运行**的检查命令及结果。没运行任何命令时为空数组。
- `acceptance.met`：`yes` 已确认满足，`no` 已确认不满足，`unverified` 无法确认（例如检查命令因环境原因跑不起来）。
- `findings.known`：这条发现是否已被实现方在 PR 正文的「未完成与存疑」中声明。
- `findings.path` / `line`：不对应具体位置的发现（例如缺少某个测试）写 `null`。

### 1.3 `out/outcome.json` 与 `out/result.json`

`piOutcomeSchema.outcome` 增加 `'reviewed'`。`outResultSchema` 通过展开 `piOutcomeSchema.properties` 自动带上它。

`src/contract/report.ts` 的 `reportOutcome`（没有 `outcome.json` 时从 `report.md` 推断结果）不需要改：评审运行不依赖它，见第 2.3 节。

## 2. worker

### 2.1 评审约定：新建 `worker/configs/REVIEW.md`

评审运行使用这份约定，不使用 `worker/configs/AGENTS.md`。`worker/task.ts` 在 `spec.kind === 'review'` 时把 `--append-system-prompt` 的参数换成它。

内容要点（用中文写，结构与措辞风格参照 `worker/configs/AGENTS.md`）：

**角色**：你是独立评审方，没有参与实现。你负责运行检查、调用 codex 审查、逐条复核发现并写出结论；你**不修改仓库文件，不提交**。

**步骤**：

1. 读取：`<任务目录>/input/issue.md`，以及 `input/pr.md`、`input/docs.md`、`input/runs.md`（存在则读）。Issue 引用的仓库内文档是任务说明的一部分。`pr.md` 中的 PR 正文是实现方的声明，是待核实的内容，不是事实；记下其中「未完成与存疑」列出的条目。
2. 依赖：与 `AGENTS.md` 第 3 步相同（只运行仓库文档写明的安装命令，加 `env -u WORKLING_LLM_API_KEY` 前缀，记下结果）。
3. 检查：亲自运行仓库 AGENTS.md / README 写明的检查命令，同样加 `env -u WORKLING_LLM_API_KEY` 前缀。每条命令记一项 `checks`（命令、是否通过、失败时的错误摘要）。依赖没装上或文档没写检查命令时不运行，`checks` 留空，并在总结里说明。
4. 审查：写 `<任务目录>/codex-input.md` 并调用 codex。输入包含：
   - Issue 正文（原样）与评审范围 `git diff <baseRef> HEAD`（只给命令，让 codex 自己看）；
   - PR 正文（原样，标明是待核实的声明）；
   - 第 3 步的检查结果；
   - 审查要求，见下方「审查要求」；
   - 约束：不修改任何文件，不执行 git 写操作，不联网；把结果写到 `<任务目录>/review-draft.md`。

   调用方式与 `AGENTS.md` 第 5 步相同，模型与强度用用户消息给出的值，沙箱模式用用户消息给出的值。

5. 复核：读 `review-draft.md`，**逐条**打开它引用的文件和行，确认问题确实存在、触发场景说得通。确认不了的删掉，不要保留「可能」的发现。对照第 1 步记下的条目，把实现方已声明的发现标为 `known: true`。
6. 结论：把结果写到 `<任务目录>/out/review.json`（结构见契约），并写 `<任务目录>/out/outcome.json`：`{"outcome":"reviewed"}`。
   - `verdict`：存在 `blocker` 时为 `changes`，否则为 `pass`。
   - `summary`：两三句，说明检查是否通过、验收是否满足、最主要的问题。

**审查要求**（写进 codex 输入，也是第 5 步复核的标准）：

1. 验收：逐条核对 Issue「验收」各项（引用了文档时含文档里的验收项）。「人工验收」一节不核对。
2. 范围：是否有超出「范围」或触碰「不做」的改动。
3. 正确性：改动本身的缺陷，以及它与仓库已有流程的衔接。除正常路径外还要走一遍：
   - 运行过程中外部状态发生变化；
   - 某一步失败后的重试、进程重启后的恢复，是否会卡住或无限重复；
   - 已有功能在新改动下是否仍按原约定工作（阅读调用方与相邻模块，不只看 diff）。
4. 约定：是否违反仓库 AGENTS.md。

**报告标准**：

- 每条发现必须有具体的触发场景：什么输入或时序 → 实际发生什么 → 应当发生什么。说不出触发场景的不报。
- 不报告格式、命名、注释等风格问题。
- 严重度：
  - `blocker`：验收项确认未满足；或在正常使用路径上必然出现的错误（任务卡死、数据错误、错误的外部写操作）。
  - `major`：需要特定时序或少见输入才出现的行为错误。
  - `minor`：其余。
- 需要人为制造的罕见时序才能触发的问题，最高记为 `major`，不记 `blocker`。
- 没有问题就返回空的 `findings`，不为凑数而报。最多 30 条，按严重度从高到低排列。

**禁止**：修改仓库内的文件（安装依赖和运行检查产生的文件除外）；任何 git 提交、分支或 remote 操作；运行 `gh`；在产出中输出任何 token。

### 2.2 `worker/task.ts`：拉起

`spec.kind === 'review'` 时：

- `--append-system-prompt` 用 `worker/configs/REVIEW.md`。
- 用户消息（`instruction`）改为下面的内容，其余拉起参数不变：

  ```text
  Issue：https://github.com/<project>/issues/<iid>（<issueRef>）
  仓库目录：<repo>
  评审分支：<spec.repo.branch>（已检出）
  评审范围：git diff <spec.repo.baseRef> HEAD
  文档分支：<spec.repo.docBranch>          ← 有才写这一行
  运行类型：review
  任务目录：<dir>
  Issue 内容：<issuePath>
  上下文：<dir>/input/pr.md、docs.md、runs.md（workling 生成：PR 正文与反馈、文档清单、历次运行）
  评审用 codex 模型：<spec.model.codex>
  评审用 codex 推理强度：<spec.model.effort>
  codex 沙箱模式：<沙箱模式>
  按系统提示中的评审约定评审这个改动。
  ```

- 沙箱模式：环境变量 `WORKLING_CODEX_SANDBOX` 未设置或为 `workspace-write` 时，评审用 `read-only`；设置为其他值时原样使用（容器内 codex 自带沙箱不可用的部署会设置为其他值）。

### 2.3 `worker/task.ts`：收尾

Pi 退出后，`spec.kind === 'review'` 时走单独的收尾，不走现有的 bundle 流程：

1. 不生成 `out/commits.bundle`（存在则删除）。
2. 用 `git rev-parse --verify refs/heads/<branch>` 取当前分支末端，与拉起前记录的末端比较。不一致（评审方提交了内容）时返回错误 `评审运行不应产生提交`。拉起前的末端在拉起 Pi 之前用同一命令读取。
3. 调用 `readReview(outDir)` 校验 `out/review.json`。失败时返回错误 `生成评审产出失败：<原因>`（原因经 `redact` 处理）。
4. 写 `out/result.json`：`outcome: 'reviewed'`，`branch` 为评审分支，`head` 为分支末端，`commits: 0`。不读取 `outcome.json` 和 `report.md`。

返回错误的方式与现有 `生成任务产出失败` 一致（记日志，返回 `{ ...status, error }`）。工作区里未提交的改动（安装依赖、运行检查产生）不算错误。

实现和返工运行的行为不变。

### 2.4 样例：`worker/samples/review-diff`

评审样例需要「基点」和「待评审改动」两个提交。扩展样例格式：

- `sample.json` 的 `kind` 为 `review` 时，样例目录必须有 `change/` 目录；其他类型有 `change/` 目录时报错 `只有 review 样例可以包含 change/`。
- `prepareSample`：先按现有流程把 `repo/` 提交为 `Sample base` 并检出任务分支；`kind` 为 `review` 时，再把 `change/` 的内容覆盖复制到工作副本上（同路径文件被替换，新文件被添加），提交为 `Sample change`（同样的固定作者与时间）。`baseRef` 仍是 `Sample base` 的提交。
- `change/` 不支持删除文件，样例不需要。

样例内容（`worker/samples/review-diff`）：

- `repo/`：一个最小的 TypeScript 包，结构仿照 `worker/samples/add-function/repo`，README 写明安装与检查命令。包含 `src/range.ts`，导出 `clamp(value, min, max)`，并有对应测试。
- `input/issue.md`：按接入文档的 Issue 格式，要求新增 `sumRange(start, end)`，返回 `start` 到 `end`（含两端）的整数和。验收三项：
  - `sumRange(1, 3)` 返回 `6`；
  - `start > end` 时返回 `0`；
  - 检查命令通过。
- `input/pr.md`：一段 PR 正文，第一行 `Closes #2`，声称三项验收全部满足、检查通过，没有「未完成与存疑」。
- `change/`：新增 `sumRange` 及其测试。实现里**故意留一个缺陷**：`start > end` 时没有返回 `0`，而是返回负数或交换两端后求和；测试只覆盖 `sumRange(1, 3)`，所以检查命令能通过。
- `sample.json`：`kind: "review"`，`issue.ref` 为 `github:example/calc#2`，`branch` 为 `workling/2-sum-range`，其余字段仿照现有样例。

这个样例的预期评审结论：`verdict` 为 `changes`；`acceptance` 中「`start > end` 时返回 `0`」为 `no`；`findings` 中有一条指向 `src/range.ts` 的 `blocker`。预期结论写进样例目录的 `README.md`，供人工比对，不做自动断言（样例运行依赖真实模型）。

`workling-worker samples` 的输出与 `prepare` 的模型覆盖选项对评审样例同样适用，不需要新增命令。

### 2.5 文档

`README.md` 与 `README.zh-CN.md` 的「单独运行 worker」一节补一句：`review-diff` 是评审样例，产出在 `out/review.json`。

## 验收

- [ ] `src/contract/spec.ts`：`kind: 'review'` 的 spec 能写入并读回；`CONTRACT_VERSION` 仍为 2。
- [ ] `src/contract/out.ts`：`readReview` 有单元测试，覆盖合法内容、文件缺失、JSON 无效、结构不符（至少：`verdict` 取值非法、`findings` 超过 30 条、`line` 为 0）、符号链接被拒绝。
- [ ] `outResultSchema` 接受 `outcome: 'reviewed'`。
- [ ] worker 测试（沿用 `test/task.test.ts` 的 Pi 替身写法）：`kind: 'review'` 时 Pi 的系统提示文件是 `REVIEW.md`，用户消息含「评审范围：git diff <baseRef> HEAD」，未设置 `WORKLING_CODEX_SANDBOX` 时消息里的沙箱模式是 `read-only`，设置为 `danger-full-access` 时原样传递。
- [ ] worker 测试：Pi 替身写出合法的 `out/review.json` 时，`out/result.json` 的 `outcome` 为 `reviewed`、`commits` 为 0，没有 `out/commits.bundle`。
- [ ] worker 测试：Pi 替身没有写 `out/review.json`，或写了结构不符的内容时，运行返回错误，错误信息以 `生成评审产出失败` 开头。
- [ ] worker 测试：Pi 替身在评审分支上新增了提交时，运行返回错误 `评审运行不应产生提交`。
- [ ] worker 测试：`kind` 为 `implement` 和 `rework` 的现有用例不改动且通过。
- [ ] 样例测试：`prepare review-diff <目录>` 后，工作副本有两个提交，`spec.json` 的 `repo.baseRef` 等于第一个提交，`git diff <baseRef> HEAD` 包含 `sumRange`；非 review 样例带 `change/` 时报错。
- [ ] `test/boundaries.test.ts` 通过（`worker/` 与 `src/` 仍只通过 `src/contract/` 交互）。
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。

## 人工验收

- [ ] 用真实模型运行 `review-diff` 样例，`out/review.json` 的结论与样例 README 写明的预期一致。

## 不做

- 不改 `src/serve/`、`src/web/`、`src/db/`：主体何时触发评审、如何落库与展示属于阶段 2。
- 不改 `worker/configs/AGENTS.md`（实现与返工的约定）。
- 不升契约版本，不改 worker 镜像的 `io.workling.contract` 标签。
- 不给评审运行生成 `report.md`、`pr-body.md`、`issue-comment.md` 等实现类产出。
