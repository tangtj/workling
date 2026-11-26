# 阶段 2：进度评论

背景与整体规则见 [README.md](README.md)。本阶段依赖阶段 1 的 `runComment`、`runRound`、`formatDuration` 已在分支中。

每个 Issue 有一条由 workling 维护的进度评论，列出每一轮的类型、结果和用时，状态变化时原地编辑。它取代领取评论；每轮的结果评论（阶段 1）照常新发。

## 1. 样子

```md
### 进度 · 👀 等待评审与合并

[PR #128](https://…/pull/128)

| 轮次 | 类型 | 结果        | 用时    | 开始            |
| ---- | ---- | ----------- | ------- | --------------- |
| 1    | 实现 | 🟡 部分完成 | 24 分钟 | 11-26 04:37 UTC |
| 2    | 返工 | ✅ 完成     | 9 分钟  | 11-26 06:02 UTC |

这条评论由 workling 随进度更新；每一轮的详情见下方对应的评论。
```

整条经过 `markComment`，因此带有 AI 标识和 `<!-- workling -->` 标记，反馈采集会把它识别为自身评论。

### 标题

`### 进度 · <状态>`，状态由 `issues.status`、`issues.prState` 和最近一轮运行决定：

| `status`   | 条件                                     | 状态文案                |
| ---------- | ---------------------------------------- | ----------------------- |
| `queued`   |                                          | `⏳ 排队中`             |
| `running`  |                                          | `▶️ 第 <N> 轮进行中`    |
| `done`     | `prState` 为 `open`                      | `👀 等待评审与合并`     |
| `done`     | `prState` 为 `merged`                    | `✅ 已合并`             |
| `done`     | `prState` 为 `closed`                    | `PR 已关闭`             |
| `done`     | 没有 PR，最近一轮 `outcome` 为 `planned` | `🧩 拆解完成，等待确认` |
| `done`     | 没有 PR，其他情况                        | `💬 已答复`             |
| `failed`   |                                          | `❌ 未完成，等待处理`   |
| `canceled` |                                          | `已取消`                |

`N` 是最近一轮的轮次（`runRound`）。

### PR 行

`issues.prUrl` 非空时写一行 PR 链接（写法同阶段 1 的事实项），否则省略这一行。

### 表格

- 每个非评审运行一行，按 `id` 升序。超过 20 轮时只保留最近 20 轮，并在表格前加一行 `（更早的 <M> 轮已省略）`。
- 类型：同阶段 1（实现 / 返工 / 拆解）。
- 结果：
  - `endedAt` 为空 → `▶️ 进行中`
  - `error` 为 `已取消` → `已取消`
  - `error` 非空 → `❌ 未完成`
  - `outcome` 为 `completed` → `✅ 完成`；`partial` → `🟡 部分完成`；`answered` → `💬 答复`；`planned` → `🧩 完成`
  - 其余（升级前的历史运行）→ `已结束`
- 用时：`formatDuration`；未结束时留空。
- 开始：`MM-DD HH:mm UTC`。
- 表格不放错误原因、摘要等自由文本，避免需要转义。

### 说明行

固定为 `这条评论由 workling 随进度更新；每一轮的详情见下方对应的评论。`

## 2. 数据

用 drizzle 迁移（`bun run db:generate`）新增两列：

- `issues.progress_comment_id`：`integer`，可空。GitHub 评论的数字 id。
- `runs.outcome`：`text`，取值 `completed` / `partial` / `answered` / `planned`，可空。

`runs.outcome` 在 `reconcile` 的 `finish()` 里与其他终态字段在同一事务写入：有交付时按 `landed.partial` 写 `partial` 或 `completed`；拆解落地写 `planned`；答复写 `answered`；失败、取消时为空。不回填历史运行。

## 3. 同步

新建 `src/serve/progress.ts`：

- `renderProgress(issue, runs): string`：纯函数，按第 1 节从数据库行生成正文（不含 `markComment`）。
- `syncProgress({ db, repo, issue, command, log })`：
  1. `repo.platform` 不是 `github` 时直接返回。
  2. 重新读取该 Issue 的行与非评审运行，`renderProgress` 后 `markComment`。
  3. `progress_comment_id` 为空：`gh api --method POST repos/<path>/issues/<号>/comments --input -`，输入 `{"body": …}`；用 typebox 校验返回值含整数 `id`，写入 `progress_comment_id`。
  4. 否则：`gh api --method PATCH repos/<path>/issues/comments/<id> --input -`。命令失败且错误信息含 `HTTP 404`（评论被删除）时，清空 `progress_comment_id` 并按第 3 步重新创建一次。
  5. 任何失败只记日志 `<仓库> #<号> 更新进度评论失败：<原因>`，不抛出、不影响状态与后续评论；下一次调用自然重试。

正文完全由数据库生成，重复调用结果相同。

### 调用点

只在状态发生变化的地方调用，不在主循环里无条件调用：

| 位置                                | 时机                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/serve/launch.ts`               | 运行拉起、状态标签更新之后。原来发领取评论的位置改为调用 `syncProgress`，**领取评论删除**。 |
| `src/serve/reconcile.ts` `finish()` | 终态事务提交、标签同步之后，发送结果评论之前。                                              |
| `src/serve/pr-sync.ts`              | 某个 Issue 的 `prState` 或 `status` 在本轮同步中发生变化时（合并、关闭、失败改为完成等）。  |
| `src/serve/poll.ts`                 | 已有进度评论（`progress_comment_id` 非空）的 Issue 重新入队时，使标题变为「排队中」。       |

首次入队时不创建进度评论，第一次拉起时才创建，避免给排队后被撤回的 Issue 留评论。

阶段 1 中领取评论的「触发反馈」列表随领取评论一起删除；触发了哪些反馈仍可在反馈处理说明和控制台里看到。

## 4. 文档

`docs/workling.md` 与 `templates/repo/docs/workling.md`「状态与返工」中阶段 1 改过的那一条，再改为：

> workling 在 Issue 下维护一条进度评论，列出每一轮的类型、结果和用时；每轮结束时另发一条评论，写明结果和下一步。运行中亲自确认的待办项会勾选，依据写在结果评论里。

只改这一句，不改版本标记。

## 5. 测试

新增 `test/serve-progress.test.ts`：

- `renderProgress`：标题状态表中的每一行各有用例；表格结果列的每种取值各有用例；有 / 没有 PR 行；超过 20 轮时的省略行；评审运行不出现在表格里。
- `syncProgress`：没有评论 id 时创建并保存 id；有 id 时发出 PATCH；PATCH 返回 404 时清空并重新创建；创建返回的形状无效或命令失败时只记日志、不抛出；非 GitHub 仓库不发命令。

更新现有用例：

- `test/serve-launch.test.ts`：拉起后不再发领取评论，改为创建或更新进度评论。
- `test/serve-reconcile.test.ts`：各终态都写入对应的 `runs.outcome`；进度评论的更新先于结果评论；进度评论更新失败时结果评论照常发送。
- `test/pr-sync.test.ts`：PR 合并或关闭使状态变化时更新进度评论；状态未变化时不发命令。
- `test/serve-poll.test.ts`：已有进度评论的 Issue 重新入队时更新，首次入队时不创建。
- `test/db.test.ts` 等涉及表结构的用例按新列更新。

## 6. 验收

- 第 1–4 节的规定全部满足，第 5 节列出的场景都有用例。
- 迁移由 `bun run db:generate` 生成，旧库升级后两列为空，行为与阶段 1 一致，只是多出进度评论。
- 进度评论的任何失败都不改变 Issue 状态、标签和结果评论。
- `src/serve/launch.ts` 不再发送领取评论。
- `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
