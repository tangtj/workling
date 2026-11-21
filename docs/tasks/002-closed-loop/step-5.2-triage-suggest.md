# 5.2 分诊建议级

> 入口文档见 [README.md](README.md)（6.4 分诊：分级放开），路线图见 [roadmap.md](roadmap.md)，上一步见 [step-5.1-triage-shadow.md](step-5.1-triage-shadow.md)。本步在影子模式之上增加「建议」级别：判定为 `needs_info` 时打 `workling:needs-info` 标签，并按模板评论缺什么。这是分诊第一次写 GitHub。`accept` 仍然只记录，等人打 ready。

## 1. 目标

- 仓库可以把分诊切到「建议」。此后受信作者的 Issue 被判为 `needs_info` 时，自动打 `workling:needs-info` 标签，并发一条列出缺失信息的评论。
- 作者补充正文后会重新分诊：结论不再是 `needs_info` 时摘掉标签；仍然缺信息时更新提示，但同样的缺失清单不重复评论。
- 在仓库详情页看到建议发出后人怎么处理（补充了正文，还是没改就直接打了 ready），作为是否进入 5.3 的依据。

建议级默认关闭。代码合入后，要由人在仓库详情页手动切换，才会对 GitHub 产生动作。是否打开，看 5.1 影子数据的一致率。

## 2. 与 2.3 并行

本步与 [2.3](step-2.3-rework.md) 同时推进，交叉点只有 `src/db/schema.ts` 与迁移。后合入的一方基于最新默认分支重新运行 `bun run db:generate`，并相应调整 `test/db.test.ts` 的升级用例。本步不改 `src/serve/feedback.ts`、`launch.ts`、`context.ts` 和 Issue 详情页。

## 3. 数据结构

drizzle 迁移（`bun run db:generate`）：

- `repos.triageLevel`：enum 增加 `suggest`，即 `off` / `shadow` / `suggest`。SQLite 的 text enum 只在 TypeScript 层生效，不需要改表。
- `repos.triageSince`：timestamp，可空。每次通过接口修改分诊级别时写入当前时间，作为建议动作的时间下限（见 4.3）。
- `triage_records` 新增：

| 字段                | 类型            | 说明                                                       |
| ------------------- | --------------- | ---------------------------------------------------------- |
| `suggestedAt`       | timestamp，可空 | 本记录的建议（标签 + 评论）完成的时间                      |
| `suggestCommentUrl` | text，可空      | 建议评论的链接；同样的缺失清单不重复评论时，沿用上一条链接 |
| `suggestError`      | text，可空      | 最近一次打标签或评论失败的原因（已脱敏）                   |
| `labelRemovedAt`    | timestamp，可空 | workling 摘掉 `workling:needs-info` 的时间                 |

## 4. 轮询

### 4.1 范围

`src/serve/triage.ts` 的 `triageShadow` 改名为 `triageIssues`，`src/serve/index.ts` 同步改调用名。处理 `triageLevel` 为 `shadow` 或 `suggest` 的仓库。分诊流程（冷静期、内容哈希、可信判定、确定性检查、LLM、合并结论、每轮 5 次 LLM 调用上限）保持 5.1 的行为不变。

Issue 列表的 typebox schema 增加 `labels: Array<{ name: string }>`，用于下面的判断。

### 4.2 标签

`src/serve/poll.ts` 的 `WORKLING_LABELS` 增加：

```ts
{ name: 'workling:needs-info', color: 'FBCA04', description: '信息不全，补充正文后会重新分诊' }
```

`ensureLabels` 在每次进程启动后的首轮对每个仓库执行一次，升级重启后会自动创建这个标签。

### 4.3 建议动作

只在仓库为 `suggest` 时执行。每轮对本轮拉到的每个 Issue，在完成分诊（或判断无需重新分诊）后，取该 Issue **最新一条有结论的记录**（`decision` 非空，按 `triagedAt` 降序），依次判断：

1. **在 workling 流程中**：Issue 带有 `workling:ready` / `queued` / `running` / `done` / `failed` 任一标签，或者已在 `issues` 表中，就不发建议。如果同时带着 `workling:needs-info`，就摘掉它（4.4）。
2. **需要建议**：`decision = 'needs_info'`、`suggestedAt` 为空、`triagedAt >= repos.triageSince`，满足这三条时：
   1. `gh issue edit <号> -R <path> --add-label workling:needs-info`（Issue 已带这个标签时跳过这一步）；
   2. 如果该 Issue 上一条 `suggestedAt` 非空的记录的 `missing` 与本条相同（按集合比较），就不再评论，`suggestCommentUrl` 沿用上一条；否则按第 5 节模板发评论，记录返回的链接；
   3. 写入 `suggestedAt`，清空 `suggestError`。

   任何一步失败：写 `suggestError`（经 `redactSecrets`），`suggestedAt` 保持为空，下一轮重试；记日志。打标签是幂等操作，重试不会造成重复。

3. **不再需要**：`decision` 为 `accept` 或 `ignore`，且 Issue 带着 `workling:needs-info` 时，摘掉标签（4.4）。

`triageSince` 下限的作用：从影子切到建议时，之前积压的 `needs_info` 记录不会集中补发评论，只有切换之后新做出的分诊才会产生动作。

每个仓库每轮最多发 5 条建议评论，超出的留到下一轮。

### 4.4 摘标签

`gh issue edit <号> -R <path> --remove-label workling:needs-info`。只在 Issue 当前确实带着该标签时调用。成功后在该 Issue 最新一条有结论的记录上写 `labelRemovedAt`；失败只记日志，下一轮再试。人手动加上的 `workling:needs-info` 同样会按这些规则摘除；在接入文档里说明「这个标签由 workling 管理」，留到 5.3 更新接入文档时一起做。

### 4.5 不处理

- 已关闭的 Issue（不在拉取范围内），标签保持原样。
- `ignore` 不评论，也不打标签。
- 级别从 `suggest` 改回 `shadow` 或 `off` 后，不再新增或摘除标签，已有标签保持原样。

## 5. 评论模板

放在 `src/serve/triage-comment.ts`，导出 `suggestComment(missing: string[]): string`：

```md
workling：这个 Issue 暂时还不能直接交给 workling 执行，还缺少以下信息：

- <缺失项 1>
- <缺失项 2>

补充正文后不需要其他操作，workling 会在正文修改 10 分钟后重新判断；信息齐全后摘掉 `workling:needs-info`。如果认为已经可以执行，直接打 `workling:ready`。

（自动分诊 · 建议级）
```

缺失项来自记录的 `missing`，其中一部分是 LLM 生成的文字，要当作不可信内容处理：

- 每项先去掉换行和首尾空白，截到 200 字；
- 去掉 Markdown 图片与链接语法，裸 URL 替换为 `（链接已省略）`；
- 经 `neutralizeMentions`（移到 `src/serve/comment.ts`，`land.ts` 改为从这里导入）和 `redactSecrets` 处理；
- 处理后为空的项丢弃。全部为空时用一项 `目标、范围或验收描述不够清楚`。

最终正文经 `markComment` 加上 workling 标记。`note` 永远不发到 GitHub。

## 6. 接口与页面

- `PUT /api/repos/:id/triage-level`：`level` 接受 `off` / `shadow` / `suggest`，写入 `triageSince`。
- `GET /api/repos/:id/triage`：`level` 的 schema 增加 `suggest`。每条记录增加 `suggestedAt`、`suggestCommentUrl`、`suggestError`、`labelRemovedAt`，另加 `followUp`（见下）。`summary` 增加 `suggestions: { total, edited, readyWithoutEdit, pending }`：
  - `total`：`suggestedAt` 非空的记录数（同一 Issue 的多次建议分别计数）；
  - `edited`：之后该 Issue 出现了内容哈希不同的新记录，即作者补充或修改过正文；
  - `readyWithoutEdit`：没有新记录，且 `issues.createdAt` 晚于 `suggestedAt`，即人没改正文就直接打了 ready，可以视为不认同这条建议；
  - `pending`：其余情况。
  - 记录上的 `followUp` 取值为 `edited` / `readyWithoutEdit` / `pending` / `null`（未建议）。
- 仓库详情页的分诊卡片：
  - 级别开关增加「建议」。切换到建议前用确认框说明：会对受信作者信息不全的 Issue 打标签并评论。
  - 汇总区增加建议跟进的四个数字；`readyWithoutEdit / total` 显示为「建议被跳过的比例」。
  - 列表中有建议的记录显示「已提示」和评论链接，`suggestError` 可展开查看，`labelRemovedAt` 非空时显示「已摘标签」。

## 7. 测试

用命令替身与 `classify` 替身：

- `shadow` 仓库不打标签、不评论（5.1 原有用例保留）。
- `suggest` 仓库：`needs_info` → 打标签、发评论，并写入 `suggestedAt` 和 `suggestCommentUrl`；`accept` / `ignore` → 不发建议。
- `triagedAt` 早于 `triageSince` 的 `needs_info` 记录不产生动作。
- 修改正文后改判为 `accept` → 摘掉标签并写 `labelRemovedAt`；仍是 `needs_info` 且缺失清单相同 → 不重复评论，沿用链接；缺失清单不同 → 发新评论。
- Issue 已在 workling 流程中（带 `workling:*` 状态标签或已在 `issues` 表中）→ 不建议；带着 `workling:needs-info` 时摘除。
- 打标签或评论失败 → 写 `suggestError`，下一轮重试成功。
- 每轮最多 5 条评论。
- 评论模板：链接、图片、`@` 提及、换行、超长、全部为空时的兜底；带 `<!-- workling -->` 标记。
- 接口：三种级别切换并写入 `triageSince`；`suggestions` 汇总四个数字与 `followUp` 的计算。
- `WORKLING_LABELS` 包含 `workling:needs-info`。

## 8. 验收

- [ ] 仓库详情页可以把分诊切到「建议」，切换前有确认提示
- [ ] 建议级下，受信作者写的信息不全的新 Issue，在冷静期过后被打上 `workling:needs-info`，并收到列出缺失项的评论；评论里不出现 `note`、链接或 `@` 提及
- [ ] 作者补全正文后，重新分诊为 `accept` 时标签被摘除；仍然缺同样的信息时不重复评论
- [ ] 打了 `workling:ready` 或已进入 workling 流程的 Issue 不会被提示，已有的 `workling:needs-info` 会被摘除
- [ ] 从影子切到建议时，之前积压的 `needs_info` 记录不会集中补发评论
- [ ] 影子级下 GitHub 上没有任何变化（5.1 的行为不变）
- [ ] 仓库详情页显示建议的跟进情况：已补充、未修改直接打 ready、待跟进
- [ ] 迁移可在空库与现有库上执行
- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过

## 9. 不做

- `accept` 后自动入队、`workling:hold`、更新接入文档模板（5.3）。
- 评论模板、冷静期、每轮上限做成设置项。
- 根据评论内容（而不是正文）重新分诊。
- GitLab。
