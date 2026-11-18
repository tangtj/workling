# 阶段 2：任务列表与仓库详情

> 入口文档见 [README.md](README.md)。本阶段把 `/issues` 和 `/repos/:id` 两个只读页面换成 React 组件加 JSON 接口。页面的内容、样式和交互与迁移前一致。

## 1. 范围

- `/issues`：任务列表，支持状态标签、仓库下拉框、标题或 `#编号` 搜索。
- `/repos/:id`：仓库详情，包括面包屑、仓库信息、状态标签和 Issue 表格。
- 两个页面使用同一份数据接口和同一套表格组件。概览页 `/` 也用到了 Issue 表格，但它留到阶段 3 迁移，本阶段只把表格的纯逻辑抽出来共用。

## 2. 共用的纯逻辑

新增 `src/web/issue-view.ts`。文件里不含 JSX，服务端视图和客户端组件都可以引用。把 `src/web/views/shared.tsx` 中下面这些逻辑搬过来，`shared.tsx` 改为从这里引用，行为保持不变：

```ts
// 结构化类型：服务端的 Issue（drizzle 行）和客户端解析后的数据都满足
export type IssueRow = {
  id: number
  repoId: number
  number: number
  title: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  updatedAt: Date
  runCount: number
  lastRun: { startedAt: Date; endedAt: Date | null; exitCode: number | null; error: string | null } | null
}

export const labels: Record<IssueRow['status'], string>
export const statuses: readonly ['all', 'running', 'queued', 'failed', 'done', 'canceled']
export function selectedStatus(filter: string): (typeof statuses)[number]
export function statusCounts(items: IssueRow[]): Record<string, number>
export function queuePositions(items: IssueRow[]): Map<number, number>
export function sortIssues<T extends IssueRow>(items: T[]): T[]
export function failureReason(issue: IssueRow): { label: string; advice: string }
// 从 IssueTable 里抽出"阶段/结果"列的文案
export function stageText(issue: IssueRow, now: number, queuePosition: Map<number, number>): string
// 从 IssuesPage 里抽出仓库与搜索过滤；repoId 为 undefined 表示全部仓库
export function filterIssues<T extends IssueRow>(items: T[], repoId: number | undefined, q: string): T[]
```

- 服务端的 `Issue` 类型没有 `runCount`。`shared.tsx` 在调用前用 `runs.length` 补上，或者调整 `IssueRow` 的使用方式让两边都能满足。不允许保留两份逻辑。
- `PLATFORM_ICON_PATHS` 和 `platformName` 移到新文件 `src/web/platform.ts`，由 `shared.tsx` 的 `PlatformIcon` 和客户端组件共同引用。
- `src/web/views/format.ts` 中的 `formatTime`、`formatDuration`、`prLabel` 本身就是纯函数，客户端直接引用即可，不移动文件（阶段 7 收尾时再整理目录）。

## 3. 数据接口

新增 `GET /api/issue-list`，一次返回两个页面需要的全部数据。过滤在前端完成，和现在服务端渲染的语义一致。schema 用 typebox 定义在 `src/web/issue-list.ts`，写法参照 `src/web/shell.ts`：

```ts
{
  now: string // ISO
  repos: {
    id: number
    ref: string
    platform: 'github' | 'gitlab'
    host: string
    path: string
    enabled: boolean
    tokenMask: string // 服务端用 maskToken 生成，绝不返回 token 原文
  }[]
  issues: {
    id: number
    repoId: number
    number: number
    title: string | null
    status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
    prUrl: string | null
    prState: 'open' | 'merged' | 'closed' | null
    updatedAt: string // ISO
    runCount: number
    lastRun: { startedAt: string; endedAt: string | null; exitCode: number | null; error: string | null } | null
  }[]
}
```

- 数据来自 `pageData`，返回前用 `Value.Check` 校验，`Cache-Control: no-store`。鉴权与其他 `/api/*` 相同。
- 现有的 `GET /api/issues` 和 `GET /api/issues/:id/runs` 不改。

## 4. 页面

客户端新增：

```text
src/web/client/issue-list.ts      取数（TanStack Query，key ['issue-list']）+ 校验 + 把 ISO 字符串转成 Date
src/web/client/issue-table.tsx    Badge、PR、PlatformIcon、StatusChips、IssueTable（React 版）
src/web/client/pages/issues.tsx   /issues
src/web/client/pages/repo.tsx     /repos/:id
```

- **DOM 与 class 名和现有视图 1:1 一致**（`page-head`、`card`、`toolbar`、`chips`、`chip`、`table-wrap`、`issue-cell`、`badge badge--*`、`empty` 等），不改样式和文案。
- **筛选状态保存在 URL 上**，参数沿用 `status`、`repo`、`q`：
  - 状态标签是 `<Link>`，保留当前的其他参数。
  - 仓库下拉框变化时立即更新 URL；搜索框在按回车或点击"筛选"时更新 URL。行为和现在一致。
  - 前进、后退、刷新、直接打开带参数的地址，都要显示相同的结果。
- **计数与排序**：状态标签上的数字基于"仓库加搜索"过滤后的结果；队列位置基于全部 Issue；排序用 `sortIssues`。三者都和现在一致。
- `/repos/:id`：数据里找不到该仓库时，显示与 `NotFoundPage` 相同的内容。页面标题和侧栏高亮与现在一致（`任务` / `issues`，`仓库详情` / `repos`）。
- 加载中、出错时沿用 `LegacyPage` 已有的提示样式和"重试"按钮。401 时跳转 `/login`（复用 `readResponse`）。
- 不增加自动刷新（这两个页面现在就没有）。站内导航进入页面时重新取数。
- 路由：`src/web/client/main.tsx` 中，`/issues` 和 `/repos/:id` 不再映射到 `LegacyPage`，改为映射到新组件；loader 先预取 `['issue-list']`，作用和现在预取片段相同，保证滚动位置恢复正确。

## 5. 服务端与旧代码清理

- `src/web/routes/pages.ts`：`/issues` 和 `/repos/:id` 不再渲染片段。普通请求和片段请求都返回外壳。仓库不存在时，状态码仍为 404。
- 删除 `src/web/views/issues.tsx` 和 `src/web/views/repo.tsx`。
- 删除 `src/web/assets/app.js` 中 `#issue-filter` 相关的代码。
- `shared.tsx` 中只剩概览页还在用的部分（`IssueTable` 等），阶段 3 再迁移。

## 6. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] 测试：`/api/issue-list` 的字段和类型通过 schema 校验，返回内容中不含任何仓库 token 原文；未登录时返回 401。
- [ ] 测试：`/issues`、`/repos/:id` 的普通请求和片段请求都返回外壳；仓库不存在时返回 404。
- [ ] 测试：`issue-view.ts` 的 `filterIssues`（标题、`#编号`、纯数字、仓库）、`statusCounts`、`queuePositions`、`sortIssues`、`stageText`、`failureReason`，用表驱动用例覆盖，结果与迁移前一致。
- [ ] 手动（`bun run dev`）：两个页面与迁移前逐项对比外观；状态标签、仓库下拉框、搜索的组合在前进、后退、刷新、深链接下表现一致；`/repos/<不存在的 id>` 显示不存在页面；点击表格中的 Issue 进入详情页（仍是旧片段页）；外链在新标签页打开；控制台没有 CSP 报错；深色模式下切换页面不闪白。

## 7. 不做

- 不迁移概览、Issue 详情、执行日志等其他页面，也不改它们的片段逻辑。
- 不改视觉和文案，不增加新的筛选能力。
- 不改现有的 `/api/issues` 系列接口。
