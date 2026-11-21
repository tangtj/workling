# 阶段 1：颜色 token、阶段派生、任务列表按阶段筛选

> 入口文档见 [README.md](README.md)。本阶段只做数据派生和列表页，不改概览、Issue 详情和分诊。

## 1. 目标

- 任务列表 `/issues` 和仓库详情 `/repos/:id` 的 Issue 表按**阶段**（README 第 5 节）显示和筛选，能看到「PR 待审」「返工中」「返工到上限」。
- 表格显示工作分支和轮次。
- 侧栏「任务」的计数改为「需要处理」数（失败 + 返工到上限）。

## 2. 阶段派生

新建 `src/web/stage.ts`，导出纯函数与类型：

```ts
export type Stage =
  | 'queued' | 'running' | 'rework' | 'review' | 'capped' | 'failed' | 'done' | 'canceled'

export function issueStage(input: {
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  prState: 'open' | 'merged' | 'closed' | null
  lastRun: { kind: 'implement' | 'rework'; endedAt: Date | null } | null
  // 该 Issue 下 status = 'capped' 的反馈的 createdAt
  cappedFeedbackAt: Date[]
}): Stage

export const stageLabels: Record<Stage, string>
// queued 排队 · running 执行中 · rework 返工中 · review PR 待审 · capped 返工到上限
// failed 失败 · done 完成 · canceled 已取消

export const attentionStages: Stage[] = ['failed', 'capped']
```

规则（按顺序匹配，命中即返回）：

1. `status = 'running'`：`lastRun?.kind === 'rework'` → `rework`，否则 `running`。
2. `status` 为 `queued` / `failed` / `canceled` → 同名阶段。
3. `status = 'done'` 且 `prState = 'open'`：
   - `cappedFeedbackAt` 中有晚于 `lastRun.endedAt` 的时间（`lastRun` 为空或 `endedAt` 为空时，任一条都算）→ `capped`；
   - 否则 → `review`。
4. 其余（`done` 且 PR 为空、已合并或已关闭）→ `done`。

`test/` 下新增表驱动用例覆盖上面每条分支，包括「capped 反馈早于最近一轮结束 → review」。

## 3. 接口

`GET /api/issue-list`（`src/web/routes/pages.ts`，schema 在 `src/web/issue-list.ts`）每个 issue 增加三个字段：

| 字段     | 类型             | 来源                                                                                              |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `stage`  | `Stage`          | `issueStage(...)`；`cappedFeedbackAt` 一次查出所有 `capped` 反馈后按 `issueId` 分组，不要逐条查库 |
| `branch` | `string \| null` | `lastRun.branch`                                                                                  |
| `rounds` | `integer`        | 该 Issue 的运行次数（等于现有 `runCount`，保留 `runCount` 不删）                                  |

`lastRun` 对象增加 `kind` 字段。

`GET /api/shell` 增加 `attention: integer`：所有 Issue 中 `stage` 属于 `attentionStages` 的数量。现有 `failed` 字段保留。

## 4. 页面

### 4.1 筛选

`src/web/issue-view.ts` 中现有按 `status` 筛选的 `statuses` / `selectedStatus` / `statusCounts` 改为按 `stage`：

- 筛选项顺序：全部 · 需要处理 · 排队 · 执行中 · 返工中 · PR 待审 · 返工到上限 · 失败 · 完成 · 已取消。「需要处理」= `attentionStages`。每项显示数量，数量为 0 的项也显示。
- URL 参数改为 `?stage=`，取值为 `all`、`attention` 或某个 `Stage`。为兼容旧链接，仍接受 `?status=`：取值是合法阶段时按阶段处理（`failed`、`queued`、`running`、`done`、`canceled` 都是阶段名），否则视为 `all`。
- 概览、侧栏等处已有的 `/issues?status=failed` 链接改为 `/issues?stage=failed`。

### 4.2 表格

`src/web/client/issue-table.tsx` 的列改为：**Issue · 阶段 · 分支 / PR · 轮次 · 更新**。

- Issue：仓库 ref + `#编号`（等宽、次要色），下一行标题链接到 `/issues/:id`。
- 阶段：新的 `StageBadge`（`badge--<stage>` + 圆点 + `stageLabels`）。排队时沿用现有队列位置，显示「排队 #N」。
- 分支 / PR：第一行等宽的 `branch`（为空显示「—」），第二行沿用现有 `PR` 组件。
- 轮次：`rounds`。
- 更新：沿用现有相对时间。

排序沿用 `sortIssues`，把其中的状态优先级换成阶段优先级：`failed`、`capped`、`rework`、`running`、`queued`、`review`、`done`、`canceled`，同阶段按更新时间倒序。

### 4.3 样式

`src/web/assets/style.css`：

- 在 `:root`、`@media (prefers-color-scheme: dark)` 和 `[data-theme='dark']` 三处 token 定义中加入 README 第 6 节的 `--review`、`--review-soft`、`--rework`、`--rework-soft`。
- 新增 `.badge--review`、`.badge--rework`、`.badge--capped`、`.dot--review`、`.dot--rework`、`.dot--capped`，写法照抄 `.badge--running` / `.dot--running`；`capped` 用 `--rework` 系颜色。

### 4.4 侧栏

`src/web/client/layout.tsx`：「任务」后的计数徽章从「N 失败」改为「N 待处理」，取 `attention`，为 0 时不显示。

## 5. 验收

- [ ] `issueStage` 表驱动测试覆盖第 2 节每条规则。
- [ ] `/api/issue-list` 返回 `stage`、`branch`、`rounds`、`lastRun.kind`，schema 校验通过；`/api/shell` 返回 `attention`。
- [ ] 任务列表与仓库详情的筛选项、计数、表格列符合第 4 节；`?stage=capped` 只显示返工到上限的 Issue；旧链接 `?status=failed` 仍筛出失败。
- [ ] 深色、浅色主题下新徽章文字对比度 ≥ 4.5:1。
- [ ] 375px 宽度下表格在容器内横向滚动，页面不横向滚动。
- [ ] `bun run check` 通过。

## 6. 不做

- 不改概览、Issue 详情、分诊和设置页。
- 不新增数据库字段或迁移。
