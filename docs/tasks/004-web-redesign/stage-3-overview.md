# 阶段 3：概览「需要你处理」

> 入口文档见 [README.md](README.md)。前置：阶段 1、2 已合入（用到 `issueStage` 和 `repoTriage`）。

## 1. 目标

打开首页就知道要处理什么：系统告警置顶；失败、返工到上限、PR 待审、信息不全合成一个待处理列表；执行名额卡片看得出是实现还是返工、第几轮。

## 2. 接口 `GET /api/overview`

在现有响应（`src/web/overview.ts` 的 schema、`src/web/routes/pages.ts` 的实现）上增改：

### 2.1 `alerts`

```ts
alerts: Array<{ kind: 'poll' | 'worker'; message: string }>
```

- `watch.lastPollError` 非空 → `{ kind: 'poll', message: '轮询失败：' + lastPollError }`。
- `watch.workerError` 非空 → `{ kind: 'worker', message: workerError + '；已暂停拉起新任务，排队中的 Issue 会等待。' }`。

### 2.2 `attention`

```ts
attention: Array<{
  kind: 'failed' | 'capped' | 'review' | 'needs_info'
  repoRef: string
  number: number
  title: string | null
  issueId: number | null // needs_info 为 null（还没有 issues 记录）
  url: string // GitHub 上的 Issue 地址
  prUrl: string | null
  since: string // 用于排序和「等了多久」
  reason: string // 一行说明，规则见下
  logRunId: number | null // failed 时为最近一轮的 id
}>
```

来源与 `reason`：

| kind         | 条件                                                             | since                                  | reason                                                                              |
| ------------ | ---------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `failed`     | `issueStage = 'failed'`                                          | 最近一轮 `endedAt`（无则 `updatedAt`） | 沿用 `issue-view.ts` 的 `failureReason(...).label`，前面加「第 N 轮<实现/返工> · 」 |
| `capped`     | `issueStage = 'capped'`                                          | 最晚一条 `capped` 反馈的 `createdAt`   | 「已自动返工 R / L 轮，PR 上的 Request changes 不再自动处理」，R、L 见 2.4          |
| `review`     | `issueStage = 'review'`                                          | 最近一轮 `endedAt`                     | 「PR 已打开，等待 review」                                                          |
| `needs_info` | 启用仓库的 `repoTriage(...).records` 中 `followUp === 'pending'` | 记录的 `suggestedAt`                   | 「已评论缺少：<missing 用顿号连接>，等作者补充」                                    |

按 `since` 升序（等得最久的在前），最多 50 条。

### 2.3 执行名额

现有 `issues[].lastRun` 增加 `kind`，`issues[]` 增加 `round`：该运行是这个 Issue 的第几轮（按 `startedAt` 升序从 1 数起）。

### 2.4 返工上限

- `ServeStatus`（`src/serve/index.ts`）增加 `reworkLimit: number`，由 serve 启动时从现有配置 `reworkLimit`（`WORKLING_REWORK_LIMIT`）填入。
- `R` 用 `src/serve/rework.ts` 的 `countAutoRounds` 计算（PR 号取自 `prUrl`），不要另写一套计数。
- 没有 serve 状态时（单测或未启动 watch）`L` 显示「—」。

### 2.5 最近 24 小时

现有统计加 `reworked`：24 小时内结束、`kind = 'rework'` 的运行数。

## 3. 页面 `src/web/client/pages/overview.tsx`

自上而下：

1. **标题区**：不变（「概览」、日期与仓库数，右侧「全部任务」「添加仓库」）。
2. **告警条**：每条 `alerts` 一行，`--failed` 描边与 `--failed-soft` 底色，左侧「系统」徽章，右侧 `worker` 告警带「查看版本」按钮（打开现有版本面板）。没有告警不渲染。
3. **需要你处理 N**（卡片）：标题右侧小字「按等待时长排序，处理后自动消失」。每行三列：类型徽章（failed 用 `badge--failed`「执行失败」，capped 用 `badge--capped`「返工到上限」，review 用 `badge--review`「PR 待审」，needs_info 用 `--warn` 色「信息不全」）· 中间两行（第一行 `repoRef#number` 等宽 + 标题；第二行 `reason` · 相对时间）· 右侧按钮：
   - failed：「看日志」→ `/runs/<logRunId>/log`，「打开」→ `/issues/<issueId>`。
   - capped：「打开 PR」→ `prUrl`（新窗口），「打开」→ `/issues/<issueId>`。
   - review：「去 review」→ `prUrl`（新窗口）。
   - needs_info：「看分诊」→ `/triage?repo=<repoId>`（`attention` 项需要带 `repoId`，加进 2.2 的字段）。
     列表为空时显示「没有要处理的事」。
4. **执行中 x / y**（卡片，替换现有「执行名额」网格）：每个运行中的 Issue 一格，格内：徽章（实现用 `badge--running`「实现 · 第 N 轮」，返工用 `badge--rework`「返工 · 第 N 轮」）+ 右上角已运行时长；`repoRef#number` + 标题；「实时日志」链接。空闲名额显示虚线框「空闲名额」，与现在一致。
5. **排队**与**最近 24 小时**两张卡片并排（窄屏上下排列）：
   - 排队：不变。
   - 最近 24 小时：四个数字「完成 · 返工 · 失败 · 平均用时」，失败数用 `--failed` 色；下方表格不变。
6. 删除现有独立的「需要处理（失败）」卡片，其内容已并入第 3 项。

轮询间隔保持 15 秒。

## 4. 验收

- [ ] `/api/overview` 返回 `alerts`、`attention`、`issues[].round`、`lastRun.kind`、`reworked`，schema 校验通过。
- [ ] 测试：构造失败、返工到上限、PR 待审、建议待补充各一条，`attention` 四类齐全、按 `since` 升序、`reason` 符合第 2.2 节；`workerError` 非空时 `alerts` 有 `worker` 一条。
- [ ] 返工到上限的 `R / L` 与 `countAutoRounds`、`WORKLING_REWORK_LIMIT` 一致。
- [ ] 页面按第 3 节显示；处理掉（如 PR 合并）后下一次轮询该行消失。
- [ ] 375px 宽度下待处理行的按钮换到下一行，页面不横向滚动。
- [ ] `bun run check` 通过。

## 5. 不做

- 不显示运行进度百分比或当前步骤（没有可靠来源）。
- 不在首页做任何写操作（重试、取消等）。
