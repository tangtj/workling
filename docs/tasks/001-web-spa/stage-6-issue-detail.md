# 阶段 6：Issue 详情与执行日志

> 入口文档见 [README.md](README.md)。本阶段把 Issue 详情 `/issues/:id` 和执行日志 `/runs/:id/log` 换成 React 组件，时间线改为 React 渲染。`timeline.js` 的纯函数改写为 TypeScript 后复用。页面的内容、样式和交互与迁移前一致。

## 1. 范围

- `/issues/:id`：面包屑、Issue 头部卡片（编号、状态、标题、执行次数与时间、"在 GitHub 打开"、PR）、重试提示、执行历史（每次运行一张卡片，内含折叠的"执行过程"精简时间线）。
- `/runs/:id/log`：页头（Issue、第几次、结果、开始时间、用时、机器、容器或 pid）、codex 结论与 Pi 结论、执行阶段条、时间线工具栏（筛选、跟随最新、原始日志、下载、实时更新中）、完整时间线、原始日志。
- 现有实现：`src/web/views/issue.tsx`、`src/web/views/run-log.tsx`（片段模式），`src/web/assets/run-log.js`（约 430 行，命令式 DOM 渲染与轮询），`src/web/assets/timeline.js`（事件解析纯函数）。
- 日志接口沿用 `GET /api/runs/:id/events`、`GET /api/runs/:id/log`，**行为不变**。

## 2. 时间线模型：`src/web/timeline.ts`

- 把 `src/web/assets/timeline.js` 改写为 `src/web/timeline.ts`：导出 `createTimeline`、`applyWorklingLine`、`applyPiLine`、`applyLogLine`、`phaseOf`、`counts`、`shouldReload`，逻辑逐行保持不变，补上类型（`TimelineState`、`TimelineItem` 按 `kind` 区分的联合类型）。
- `test/timeline.test.ts` 改为引用 TS 版本，原有用例全部保留并通过。
- 删除 `src/web/assets/timeline.js`。

## 3. 读取事件：`src/web/client/run-events.ts`

把 `run-log.js` 中 `loadEvents` 的增量读取逻辑搬成 React hook，行为逐项保持一致：

```ts
export function useRunEvents(options: {
  runId: number
  initiallyEnded: boolean
  enabled: boolean // 精简时间线所在的 <details> 未展开时为 false，不发请求
  logTail?: string | null // 仅精简时间线使用：日志目录已清理时用它兜底
}): {
  state: TimelineState
  ended: boolean
  fallback: boolean // true 时显示"此次执行没有结构化事件，以下由文本日志整理"
  error: string | null
  finishedWhileViewing: boolean // 即 shouldReload(...) 为真
}
```

必须保持的细节（以 `run-log.js` 为准）：

- 按 `workling` / `pi` 两个偏移量增量请求 `/events`；未结束时每 3 秒请求一次，刚结束时立即再请求一次，结束且没有新进展后停止。
- `pi_exit` 之后的 workling 行延后到本批 Pi 事件处理完再应用（两个文件没有公共序号）。
- 收到 `fallback` 时用文本日志重建整个时间线；之后又出现结构化事件时清空重来。
- 精简时间线遇到"日志已清理"且有 `logTail` 时，用 `applyLogLine` 解析 `logTail` 兜底，并显示 fallback 提示。
- 组件卸载时中止请求、清除定时器；401 跳转 `/login`（复用 `readResponse`）。
- 运行在查看期间结束（`finishedWhileViewing`）：完整日志页让该 Issue 的详情查询失效重取，替代原来的 `ctx.refresh()` 整块刷新；Issue 详情页同样重取，使状态和结论更新。

原始日志另写 `useRawLog(runId, enabled)`：按 `X-Log-Offset` 增量读取 `/api/runs/:id/log?offset=`，用 `TextDecoder` 流式解码，`X-Run-Ended` 为真且没有新进展时停止；无内容时显示"暂无原始日志"。只在第一次切到"原始日志"后开始读取。

## 4. 时间线组件：`src/web/client/run-timeline.tsx`

- `RunTimeline({ variant: 'compact' | 'full', ... })`。**DOM 与 class 名和 `run-log.js` 生成的结构 1:1 一致**：`run-phases`、`timeline-entry timeline-entry--<kind>`、`timeline-icon`、各图标字符、`data-status`、`timeline-details`、输出项的 `pre.mono` 等，逐个对照 `createEntry`、`updateMeta`、`render` 实现。
- 执行阶段条：五个阶段文案、已完成 `✓`、当前 `●` / 失败 `✗`、`aria-current="step"`，与现在一致。
- 精简版只显示最后 8 条（原 `data-limit="8"`），阶段条渲染在时间线内部；完整版阶段条在页面上方。
- 运行中的 codex 条目每秒刷新已用时间（只更新这部分，不重建整个列表）。
- 筛选（全部 / 命令 / 文件 / 说明 / 错误）带计数，`aria-pressed` 标记当前项；筛选规则与 `visible()` 相同。
- "跟随最新"勾选时，新条目出现后滚动到时间线底部；原始日志模式下滚动 `<pre>` 到底部。"原始日志"按钮切换时间线与原始日志的显示，`aria-pressed` 同步。

## 5. 数据接口

新增两个只读接口，返回同一形状，schema 用 typebox 定义在 `src/web/issue-detail.ts`（对象一律 `additionalProperties: false`）：

- `GET /api/issues/:id/detail`：该 Issue。
- `GET /api/runs/:id/detail`：该运行所属的 Issue（执行日志页用，客户端再按 `runId` 找到对应运行）。

```ts
{
  now: string
  issue: {
    id: number
    repoId: number
    repo: {
      ref: string
      platform: 'github' | 'gitlab'
      host: string
      path: string
    }
    number: number
    title: string | null
    status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
    prUrl: string | null
    prState: 'open' | 'merged' | 'closed' | null
    createdAt: string
    updatedAt: string
  }
  runs: {
    // 按 startedAt 降序
    id: number
    worker: string
    startedAt: string
    endedAt: string | null
    exitCode: number | null
    error: string | null
    summary: string | null
    reportResult: string | null
    logTail: string | null
    taskDir: string | null
    pid: number | null
    container: string | null
  }
  ;[]
}
```

- 不存在时返回 404 `{ error }`。返回前 `Value.Check`，`Cache-Control: no-store`。不含 token。
- `summary`、`logTail` 已在入库时脱敏，接口不再处理。

## 6. 页面

```text
src/web/client/issue-detail.ts       取数（key ['issue-detail', issueId]、['run-detail', runId]）+ 校验 + 时间转换
src/web/client/pages/issue.tsx       /issues/:id
src/web/client/pages/run-log.tsx     /runs/:id/log
```

- **DOM 与 class 名和现有视图 1:1 一致**，文案不变（包括"重试：在 GitHub 上给这个 Issue 重新打上 workling:ready……"提示）。复用 `issue-table.tsx` 的 `Badge`、`PR`、`PlatformIcon`。
- Issue 详情：每次运行的"执行过程"是 `<details>`，第一条默认展开；其余展开时才开始读取事件。"复制路径"按钮复制 `taskDir`，2 秒内显示"已复制"。
- 执行日志：页头的"用时"在运行中每秒更新；"实时更新中"在运行结束后隐藏；"下载"仍是指向 `/api/runs/:id/log` 的 `download` 链接。
- 不存在的 Issue 或运行显示与 `NotFound` 相同的内容，侧栏不高亮；存在时页面标题分别为 `Issue 详情 · Workling`、`执行日志 · Workling`，侧栏高亮 `issues`。
- 站内链接（面包屑、"查看完整时间线"、Issue 链接）用 `<Link>`；GitHub 与 PR 外链在新标签页打开。
- 路由：`/issues/:id`、`/runs/:id/log` 从 `LegacyPage` 列表移出，loader 预取对应详情查询。

## 7. 服务端与旧代码清理

- `src/web/routes/pages.ts`：两个路由的普通请求和片段请求都返回外壳；Issue 或运行不存在时状态码为 404。
- 删除 `src/web/views/issue.tsx`、`src/web/views/run-log.tsx`、`src/web/assets/run-log.js`、`src/web/assets/timeline.js`，以及 `src/web/assets.ts`、`src/web/routes/assets.ts`、`src/web/bundle.ts`（`external`）、`src/web/client/legacy.ts`（`loadRunLog`）、`legacy-page.tsx` 中对它们的引用。
- `app.js` 中只剩已无人使用的代码时一并删除；`LegacyPage` 此后只服务于没有页面的情况，保留到阶段 7 删除。

## 8. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] 测试：两个详情接口通过 schema 校验；不存在时 404；未登录 401；`runs` 按开始时间降序。
- [ ] 测试：`/issues/:id`、`/runs/:id/log` 的普通请求和片段请求返回外壳，不存在时 404。
- [ ] 测试：`test/timeline.test.ts` 改用 `src/web/timeline.ts` 后全部通过。
- [ ] 测试：把 `useRunEvents` 中"处理一批 `/events` 响应"的部分抽成纯函数（输入当前状态与响应，输出新状态、新偏移量、是否停止、是否 `finishedWhileViewing`），用表驱动用例覆盖：增量追加、`pi_exit` 延后、fallback 重建与切回、结束后再取一次才停止、日志已清理时用 `logTail` 兜底。
- [ ] 手动（`bun run dev`）：与迁移前逐项对比两个页面外观；运行中的任务时间线每 3 秒追加、codex 条目每秒走时；运行结束后状态与结论自动更新；筛选、跟随最新、原始日志、下载正常；折叠的历史运行展开时才请求；日志已清理的旧运行显示兜底内容；控制台没有 CSP 报错。

## 9. 不做

- 不改 `/api/runs/:id/events`、`/api/runs/:id/log` 接口与 `timeline` 的解析规则。
- 不改视觉和文案，不引入 SSE / WebSocket。
- 不删除片段模式、版本面板脚本和登录页（阶段 7）。
