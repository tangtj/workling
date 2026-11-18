# 阶段 3：概览页

> 入口文档见 [README.md](README.md)。本阶段把概览页 `/` 换成 React 组件加 JSON 接口，用 TanStack Query 每 15 秒轮询，替代片段整块刷新。页面的内容、样式和交互与迁移前一致。

## 1. 范围

- `/`：页头、watch 健康条、执行名额、需要处理（失败）、排队、最近 24 小时（指标与表格）。
- 现有实现：`src/web/views/overview.tsx`，由片段模式渲染，`X-Workling-Refresh: 15` 驱动 `LegacyPage` 每 15 秒重新拉片段并整块替换。

## 2. 共用的纯逻辑

新增 `src/web/overview-view.ts`（不含 JSX）。把 `OverviewPage` 里的计算搬过来，输入只用 JSON 接口里有的字段：

```ts
export type OverviewRun = {
  id: number
  startedAt: Date
  endedAt: Date | null
  exitCode: number | null
  error: string | null
}
export type OverviewIssue = IssueRow & { repoRef: string; runs: OverviewRun[] } // IssueRow 来自 issue-view.ts

export function runResult(run: OverviewRun): 'running' | 'done' | 'failed' // 即现在 shared.tsx 的 result
export function overviewModel(
  issues: OverviewIssue[],
  now: number,
  concurrency: number,
): {
  running: OverviewIssue[] // 按 lastRun.startedAt 升序
  queued: OverviewIssue[] // 按 updatedAt 升序
  failed: OverviewIssue[] // 按 updatedAt 降序
  recent: { issue: OverviewIssue; run: OverviewRun }[] // 结束于 [now - 24h, now] 的运行，按 endedAt 降序
  meanMs: number | null // recent 的平均用时，没有记录时为 null
  idle: number // max(0, concurrency - running.length)
}
// 执行名额卡片的时间条：limitSeconds 为 null 表示 watch 状态未知
export function slotTiming(
  startedAt: Date,
  now: number,
  timeoutMinutes: number | null,
): {
  elapsedSeconds: number
  limitSeconds: number | null
  hot: boolean
  remainingMinutes: number | null
}
```

- 排序、24 小时窗口、`hot`（剩余不足 20%）、剩余分钟向上取整，全部与现在的 `overview.tsx` 一致。
- `shared.tsx` 的 `result` 改为引用 `runResult`，不保留两份。

## 3. 数据接口

新增 `GET /api/overview`，schema 用 typebox 定义在 `src/web/overview.ts`（写法参照 `src/web/issue-list.ts`，对象一律 `additionalProperties: false`）：

```ts
{
  now: string // ISO
  repos: { total: number; enabled: number }
  concurrency: number
  watch: {
    worker: string
    timeout: number // 分钟
    lastPollAt: string | null
    lastPollError: string | null
  } | null // serve 状态未知时为 null
  issues: {
    id: number
    repoId: number
    repoRef: string
    number: number
    title: string | null
    status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
    prUrl: string | null
    prState: 'open' | 'merged' | 'closed' | null
    updatedAt: string
    runCount: number
    lastRun: { id: number; startedAt: string; endedAt: string | null; exitCode: number | null; error: string | null } | null
    runs: { id: number; startedAt: string; endedAt: string | null; exitCode: number | null; error: string | null }[]
  }[]
}
```

- 数据来自 `pageData`。为控制体积，`issues` 只包含 `running`、`queued`、`failed` 三种状态的 Issue，以及至少有一次运行结束于最近 24 小时的 Issue；`runs` 只包含 `lastRun` 和结束于最近 24 小时的运行。概览页用不到其余数据。
- 返回前用 `Value.Check` 校验，`Cache-Control: no-store`。鉴权与其他 `/api/*` 相同；返回中不含仓库 token。
- 不改 `/api/shell`、`/api/issue-list`。

## 4. 页面

客户端新增：

```text
src/web/client/overview.ts         取数（key ['overview']）+ 校验 + ISO 字符串转 Date
src/web/client/pages/overview.tsx  /
```

- **DOM 与 class 名和现有视图 1:1 一致**（`page-head`、`health`、`slots`、`slot`、`slot idle`、`timebar`、`grid g-2`、`card`、`list`、`li`、`qnum`、`advice`、`kpis`、`kpi`、`table-wrap`、`issue-cell`、`badge badge--*`、`empty` 等），文案不变。复用 `src/web/client/issue-table.tsx` 的 `Badge`、`PR`；`Badge` 需要支持可选的 `text`（失败原因标签），按需扩展签名。时间文案用 `src/web/views/format.ts` 的 `formatTime`、`formatDuration`、`relativeTime`、`secondsAgo`。
- 站内链接（`/issues`、`/repos#add`、`/issues/:id`、`/runs/:id/log`、`/issues?status=failed`）用 `<Link>`；PR 外链仍在新标签页打开。
- **轮询**：`useQuery` 的 `refetchInterval` 为 15 秒，且满足下面全部条件时才发请求，条件与 `LegacyPage` 现在的判断相同：
  - `document.hidden` 为假；
  - 页面上没有打开的对话框（`dialog[open], [role="dialog"]:not([hidden])`）；
  - `document.body.dataset.refreshPaused !== 'true'`（版本面板更新时会暂停）。

  建议用 `refetchInterval` 函数返回 `false` 暂停，或保留定时器加条件判断，二选一。离开概览页后不再轮询。

- **刷新不闪烁**：重新取数期间保留旧数据（不显示"加载中"），只有首次加载显示"加载中…"。不要用 `key` 强制整块重新挂载，滚动位置和焦点保持不动。
- 页面标题 `概览 · Workling`，侧栏高亮 `overview`，与现在一致。
- 加载失败沿用 `pages/issues.tsx` 的"加载页面失败 + 重试"写法；已有数据时后台刷新失败不清空页面，只显示提示条。401 时跳转 `/login`（复用 `readResponse`）。
- 路由：`src/web/client/main.tsx` 中 `/` 从 `LegacyPage` 列表移出，映射到新组件；loader 先预取 `['overview']`。

## 5. 服务端与旧代码清理

- `src/web/routes/pages.ts`：`/` 的普通请求和片段请求都返回外壳（与阶段 2 的 `/issues` 相同）。
- 删除 `src/web/views/overview.tsx`。`shared.tsx` 中只被概览页用到的导出（例如 `IssueLink`、`result` 若已无其他引用）一并删除；仍被其他旧页面用到的保留。
- 片段模式此后不再有页面返回 `X-Workling-Refresh`。`render` 里的 `refresh` 参数、`LegacyPage` 的定时刷新和 `Fragment.refresh` 字段**保留到阶段 7 再删**，本阶段不动，避免扩大改动面。
- `src/web/views/layout.tsx` 的 `data-autorefresh` 与 `app.js` 中对应代码，如果确认已无页面使用，一并删除；不确定就保留并在 PR 里说明。

## 6. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] 测试：`/api/overview` 的返回通过 schema 校验，不含 token 原文；未登录返回 401；只包含第 3 节规定范围内的 Issue 和运行（有一个 24 小时前结束、状态为 `done` 的 Issue 不出现）。
- [ ] 测试：`/` 的普通请求和片段请求都返回外壳。
- [ ] 测试：`overview-view.ts` 的 `overviewModel`（三个列表的排序、24 小时窗口边界、`meanMs`、`idle`）、`slotTiming`（`hot` 临界、剩余分钟取整、watch 未知）、`runResult`，用表驱动用例覆盖，结果与迁移前一致。
- [ ] 手动（`bun run dev`）：与迁移前逐项对比外观；停留在概览页时每 15 秒自动更新且不闪烁、不跳动滚动位置；切到后台标签页时不请求；打开对话框或版本面板更新期间不请求；离开概览页后不再请求；深色模式下切换页面不闪白；控制台没有 CSP 报错。

## 7. 不做

- 不迁移仓库、设置、Issue 详情、执行日志等其他页面。
- 不改视觉和文案，不改轮询间隔，不引入 SSE / WebSocket。
- 不删除片段模式的刷新机制（阶段 7 统一清理）。
