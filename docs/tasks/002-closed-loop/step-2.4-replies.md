# 2.4 逐条回复与返工轮数上限

> 入口文档见 [README.md](README.md)（6.3 反馈返工），路线图见 [roadmap.md](roadmap.md)。依赖 [2.3](step-2.3-rework.md)：反馈经 `observed → pending → included` 进入运行，`input/feedback.md` 用 `F<id>` 标注每条反馈。

## 1. 目标

- 每条进入运行的反馈都有处理说明：PR 行内评论回在原线程里，其他来源按「反馈出现的位置」汇总成一条评论。
- 只由 `CHANGES_REQUESTED` review 触发的自动返工，每个 PR 最多 `WORKLING_REWORK_LIMIT` 轮（默认 3）；超过后评论说明，等人用指令显式触发。

## 2. 契约：`out/replies.json`

`src/contract/out.ts` 新增：

```ts
repliesSchema = Array(Object({ feedbackId: Integer({ minimum: 1 }), body: String({ minLength: 1, maxLength: 10000 }) }), { maxItems: 100 })
readReplies(dir): Promise<Reply[]>   // 文件不存在返回 []；最多读 1 MiB；JSON 或结构无效时抛错
```

不改 `CONTRACT_VERSION`：文件可选，旧 worker 不写时主体退化为「未单独说明」。

## 3. 发送回复

新增 `src/serve/replies.ts`，导出 `publishReplies({ db, repo, issue, run, taskDir, prUrl, command, llmApiKey, log })`，由 `reconcile` 在落地成功（`done`，含答复模式）并完成现有 Issue 评论后调用。运行失败时不发送，失败评论已说明情况，反馈保持 `included`。

1. 读取本次运行 `included` 的反馈（按 `createdAt`、`id` 升序）。为空直接返回。
2. 读取 `replies.json`。读取失败只记日志，按全部未说明处理。只采用 `feedbackId` 属于本次运行的回复；同一 ID 多条取第一条。
3. 分组：
   - `review_comment` 且有回复 → **原线程**：`gh api --method POST repos/<path>/pulls/<pr>/comments/<externalId>/replies --input -`，正文 `{"body": ...}`。PR 号取反馈自身的 `prNumber`。
   - `issue_comment` → **Issue 汇总**：`gh issue comment`。
   - 其余（`pr_comment`、`review`、没有回复的 `review_comment`）→ **PR 汇总**：`gh pr comment <prUrl>`；`prUrl` 为空时并入 Issue 汇总。
4. 汇总评论格式：

   ```md
   workling：反馈处理说明

   ### F12 · Review（CHANGES_REQUESTED）· @alice

   <url>

   <回复，或「（本轮未单独说明，见 Issue 评论中的总结。）」>
   ```

   作者名用 `neutralizeMentions` 处理，避免再次通知；线程回复正文以 `workling：` 开头。所有正文经 `redactSecrets`、`neutralizeMentions`、`truncateComment`、`markComment`。

5. 每条评论发送成功后，把其中包含的反馈改为 `replied`；失败只记日志（`<仓库> #<号> 回复反馈 F<id> 失败`），状态保持 `included`，不重试。

## 4. 自动返工轮数上限

`src/config/env.ts` 新增 `reworkLimit: integer('WORKLING_REWORK_LIMIT', 3, 0, 100)`，0 表示不自动返工。`queueRework` 增加 `reworkLimit` 参数。

- **自动批次**：本批每一行都是 `source = 'review'`。含任何其他来源的指令时按显式触发处理，不受上限限制。
- **已用轮数**：当前 PR 号上的自动返工运行数——`runs.kind = 'rework'` 的运行中，其 `included` / `replied` 反馈都属于当前 PR，且没有 `source != 'review' and isCommand = true` 的行。决策写成纯函数 `countAutoRounds(prNumber, rows)`，输入该 Issue 的全部反馈。
- **达到上限**：本批反馈改为新状态 `capped`（条件更新，仍为 `observed` 才改），不入队，在 PR 上评论一次：

  ```md
  workling：本 PR 已自动返工 3 轮，达到上限（WORKLING_REWORK_LIMIT=3），这次 Request changes 不再自动处理。需要继续时请评论 `/workling <说明>`。
  ```

  评论失败只记日志。下一个 review 到来时再次判定、再次评论。

`feedback.status` 枚举增加 `capped`（SQLite text 列，无需迁移）。

## 5. Pi 提示词

`configs/workling/AGENTS.md`：有本轮反馈时，把逐条处理说明写到 `out/replies.json`（每个 `F<id>` 一条，`feedbackId` 写数字），说明已改 / 未改及原因；`out/issue-comment.md` 只写本轮总结，不再逐条列出。

## 6. Web

Issue 详情页反馈状态：`replied` 显示「已回复」并链接运行日志；`capped` 显示「超过自动返工上限」。

## 7. 测试

- `readReplies`：缺文件、无效 JSON、结构无效、正常读取。
- `publishReplies`：行内评论回到原线程；PR 类与 Issue 类分别汇总；未说明的条目写默认文字；不属于本次运行的 `feedbackId` 被忽略；发送成功改为 `replied`，失败保持 `included`。
- `countAutoRounds`：只算当前 PR、只算纯 review 的运行。
- `queueRework`：达到上限的纯 review 批次变 `capped`、不入队、评论一次；含指令的批次不受限制；`WORKLING_REWORK_LIMIT=0` 时纯 review 不入队。
- `reconcile`：落地成功后调用回复，失败时不回复。

## 8. 验收

- [ ] 返工运行写了 `replies.json` 后，PR 行内评论下出现对应回复，其余反馈汇总成一条评论，反馈状态变为「已回复」。
- [ ] 同一 PR 第 4 次 Request changes 不再入队，PR 上出现上限说明；随后评论 `/workling ...` 仍能触发。
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
