# 2.1 反馈观察与受信账号

> 入口文档见 [README.md](README.md)（6.3 反馈返工），路线图见 [roadmap.md](roadmap.md)。本步只**观察并记录**反馈，不触发任何运行、不回复；并提供按仓库配置受信账号（允许名单）的后台入口。

## 1. 目标

- workling 能看到自己相关的 PR / Issue 上收到了哪些反馈，并判断每条反馈的作者是否可信、是否算作指令。
- 在后台按仓库维护受信账号；只填用户名或主页链接，系统换成数字 ID 保存。
- 在 Issue 详情页看到这些反馈，为 2.3 返工积累可核对的数据。

本步只做 GitHub。表结构与取值保持平台无关，GitLab 的对应关系见第 8 节，接入时不改表。

## 2. 记录范围

只记录与 workling 相关的条目，其余丢弃、不入库：

| `source`         | 含义                              | GitHub 接口                                        |
| ---------------- | --------------------------------- | -------------------------------------------------- |
| `issue_comment`  | `issues` 表中已有 Issue 下的评论  | `GET repos/{path}/issues/comments?since=`          |
| `pr_comment`     | workling PR 对话区的评论          | 同上（与 Issue 评论同一接口、同一 ID 空间）        |
| `review_comment` | workling PR 上的行内评论          | `GET repos/{path}/pulls/comments?since=`           |
| `review`         | workling PR 上的 review（含状态） | `GET repos/{path}/pulls/{n}/reviews`（无 `since`） |

- **workling PR**：`issues.prUrl` 非空的记录，PR 号取自 `prUrl` 末尾的 `/pull/<n>`。
- `issues/comments` 返回的每条评论按 `issue_url` 末尾的编号归属：编号等于某个 `issues.number` → `issue_comment`；等于某个 workling PR 号 → `pr_comment`，`issueId` 为该 PR 所属的 Issue；都不是 → 丢弃。
- `pulls/comments` 按 `pull_request_url` 末尾编号归属到 workling PR，其余丢弃。
- `review` 只查 `prState = 'open'` 的 workling PR；`state` 为 `PENDING` 的跳过（尚未提交）。

## 3. 数据结构

用 drizzle 迁移（`bun run db:generate`）新增三张表，定义在 `src/db/schema.ts`。

### 3.1 `feedback`

| 字段          | 类型                  | 说明                                                                                                                     |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`          | integer 自增主键      |                                                                                                                          |
| `repoId`      | integer，外键 cascade |                                                                                                                          |
| `issueId`     | integer，外键 cascade | 归属的 Issue                                                                                                             |
| `prNumber`    | integer，可空         | 来自 PR 的条目填写                                                                                                       |
| `source`      | text enum             | `issue_comment` / `pr_comment` / `review_comment` / `review`                                                             |
| `externalId`  | text                  | 平台原始 ID，统一存字符串                                                                                                |
| `authorId`    | text                  | 作者数字 ID，存字符串                                                                                                    |
| `authorLogin` | text                  | 作者用户名，仅用于显示                                                                                                   |
| `trust`       | text enum             | `self` / `bot` / `allowlist` / `write` / `untrusted`，见第 5 节                                                          |
| `isCommand`   | boolean               | 见第 6 节                                                                                                                |
| `instruction` | text，可空            | 去掉前缀后的指令文字（trim 后为空存 null）                                                                               |
| `body`        | text                  | 原文，超过 65536 字符截断                                                                                                |
| `path`        | text，可空            | 行内评论的文件                                                                                                           |
| `line`        | integer，可空         | 行内评论的行号（`line ?? original_line`）                                                                                |
| `reviewState` | text，可空            | review 的状态：`CHANGES_REQUESTED` / `COMMENTED` / `APPROVED` / `DISMISSED`                                              |
| `url`         | text                  | 原评论的 `html_url`                                                                                                      |
| `status`      | text enum             | 本步只写 `ignored`（不算指令）和 `observed`（算指令）。`pending` / `included` / `replied` 预留给 2.3、2.4，enum 中先声明 |
| `runId`       | integer，可空         | 预留，本步不写                                                                                                           |
| `createdAt`   | timestamp             | 平台上的创建时间                                                                                                         |
| `updatedAt`   | timestamp             | 平台上的更新时间（review 无更新时间，取 `submitted_at`）                                                                 |
| `seenAt`      | timestamp             | workling 首次入库时间                                                                                                    |

唯一索引：`(repoId, source, externalId)`。GitHub 的 `issues/comments`、`pulls/comments`、reviews 是三套 ID，可能撞号，所以唯一键包含 `source`。

### 3.2 `feedback_cursors`

| 字段        | 类型                  | 说明                                 |
| ----------- | --------------------- | ------------------------------------ |
| `repoId`    | integer，外键 cascade |                                      |
| `kind`      | text                  | `issue_comments` / `review_comments` |
| `cursor`    | timestamp             | 下一轮的 `since` 基准                |
| `startedAt` | timestamp             | 首次建立游标的时间，即开始观察的时间 |

主键 `(repoId, kind)`。

### 3.3 `trusted_users`（受信账号，即允许名单）

| 字段        | 类型                  | 说明                       |
| ----------- | --------------------- | -------------------------- |
| `id`        | integer 自增主键      |                            |
| `repoId`    | integer，外键 cascade | 名单按仓库配置             |
| `userId`    | text                  | 平台数字 ID，判定只看它    |
| `login`     | text                  | 添加时的用户名，仅用于显示 |
| `createdAt` | timestamp             |                            |

唯一索引：`(repoId, userId)`。平台与 host 由所属仓库决定，所以同名账号在不同 GitLab 实例上不会混淆。

## 4. 轮询

新增 `src/serve/feedback.ts`，导出 `observeFeedback({ db, command, log, signal, state })`，在 `src/serve/index.ts` 主循环中 `retryOnCommand` 之前调用，异常只记日志（与其他步骤一致）。只处理 `enabled` 且 `platform = 'github'` 的仓库，命令一律通过 `Command` 调 `gh api`，环境用 `ghEnv(repo.token, repo.host)`；仓库内没有任何 `issues` 记录时跳过。

每个仓库每轮：

1. **游标**：`kind` 没有游标行时，以当前时间写入 `cursor` 与 `startedAt` 并跳过本轮该 kind——**不回溯历史**，功能上线前的评论一律不入库。
2. **增量拉取**：记下本轮开始时间 `T0`；以 `since = cursor - 5 分钟` 调用 `issues/comments` 与 `pulls/comments`（`sort=updated&direction=asc&per_page=100`，`--paginate --slurp`）。全部成功处理后把游标更新为 `T0`；任何一步失败则不更新游标，下一轮重来。5 分钟重叠用来容忍时钟误差，重复条目靠唯一键去掉。
3. **reviews**：对每个 `prState = 'open'` 的 workling PR 调用 `pulls/{n}/reviews`（`--paginate --slurp`），只入库 `submitted_at` 晚于该仓库 `issue_comments` 游标 `startedAt` 的 review，避免回溯；该游标行不存在时本轮不查 reviews。
4. **入库**：对每条归属到 workling 的条目，计算第 5、6 节的结果后 upsert：
   - 不存在 → 插入。
   - 已存在且 `status` 为 `ignored` / `observed`，且平台 `updatedAt` 更新 → 用新正文覆盖，并**重新计算 `isCommand`、`instruction`、`status`**；`trust` 保持首次判定值。
   - 已存在且为其他状态 → 不动。
   - 被删除的评论不处理。
5. 所有外部 JSON 先用 typebox 做形状校验（`Value.Check`），不通过则该仓库本轮失败、记日志、不更新游标。

## 5. 可信判定（`trust`）

按顺序判定，命中即停：

1. **`self`**：正文包含标记 `<!-- workling -->`。workling 自己发的所有评论都追加这个标记（见第 7 节）。因为 token 可能就是维护者本人的账号，不能用"作者 = token 账号"来排除自己。
2. **`bot`**：`user.type === 'Bot'`。
3. **`allowlist`**：`user.id` 在该仓库的 `trusted_users` 中。
4. **`write`**：`GET repos/{path}/collaborators/{login}/permission` 返回的 `permission` 为 `admin` / `maintain` / `write`。结果按 `(repoId, userId)` 在内存中缓存 10 分钟（缓存放在 `state` 里，随主循环存活）；接口返回 404 视为无权限。不使用评论里的 `author_association`，其中 `COLLABORATOR` 也包含只读协作者。
5. 其余为 **`untrusted`**。

判定在首次入库时完成，之后作者权限变化不回写旧记录。

## 6. 指令判定（`isCommand`）

只有 `trust` 为 `allowlist` 或 `write` 时才可能为 true。在此前提下：

- **前缀**：沿用现有 `src/serve/retry.ts` 的规则——正文 `trimStart()` 后以 `/workling` 或 `@<token 账号 login>` 开头（不区分大小写），且其后是空白或结尾。正文中间出现的不算。token 账号 login 用 `gh api user --jq .login` 取得并按仓库缓存（与 `retry.ts` 相同，token 变化时重新取）。前缀之后的文字 trim 后存入 `instruction`。
- **review**：`reviewState === 'CHANGES_REQUESTED'` 时为 true，`instruction` 为 review 正文（可为空）；其他状态的 review 只在正文以前缀开头时为 true。
- `isCommand` 为 true 时 `status = 'observed'`，否则 `status = 'ignored'`。

前缀改为可配置（默认 `@workling-agent`）不在本步，另开 Issue。

## 7. workling 自身评论加标记

在主体发出的所有 Issue / PR 评论正文末尾追加一行 `<!-- workling -->`（GitHub 渲染时不可见）。涉及：`src/serve/launch.ts`（领取评论）、`src/serve/reconcile.ts`（失败评论）、`src/serve/land.ts`（落地评论、PR 评论），以及其他调用 `gh issue comment` / `gh pr comment` 的位置。抽一个小函数统一追加，不改变现有正文内容；追加发生在 `neutralizeMentions`、`redactSecrets`、截断之后，保证标记不被截掉。PR 正文不需要标记（不是评论）。

## 8. GitLab 对应关系（本步不实现）

| 本文             | GitLab                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ |
| `issue_comment`  | `projects/:id/issues/:iid/notes`                                                     |
| `pr_comment`     | `projects/:id/merge_requests/:iid/notes` 中无 `position` 的 note                     |
| `review_comment` | 同上，带 `position` 的 diff note                                                     |
| `review`         | MR 的 "Request changes"（视实例版本），没有时只认前缀                                |
| 增量             | 先用 `issues?updated_after=`、`merge_requests?updated_after=` 找变动条目，再拉 notes |
| 写权限           | `projects/:id/members/all/:user_id` 的 `access_level >= 30`                          |
| bot              | 用户的 `bot` 字段                                                                    |
| 用户名换 ID      | `GET users?username=<login>`，内网实例需带 token                                     |

## 9. 接口

均需登录，响应前 `Value.Check`，`Cache-Control: no-store`；schema 用 typebox，对象 `additionalProperties: false`。

- `GET /api/issues/:id/feedback`：该 Issue 的反馈，按 `createdAt` 升序，返回第 3.1 节字段（`body` 原样返回，由前端按纯文本显示）。
- `GET /api/repos/:id/trusted-users`：受信账号列表。
- `POST /api/repos/:id/trusted-users`，请求体 `{ user: string }`：`user` 可以是用户名、`@用户名` 或主页链接（`https://<仓库 host>/<用户名>`，host 必须与仓库一致）。用仓库 token 调 `gh api users/<login>` 取 `id` 与规范 `login`；不存在返回 400「用户不存在」，已在名单中返回 409。用户名先按 GitHub 规则校验（`^[a-z\d](?:[a-z\d-]*[a-z\d])?$`，不区分大小写），不合法直接 400，不发请求。仓库不是 GitHub 时返回 400「暂只支持 GitHub」。
- `DELETE /api/repos/:id/trusted-users/:userId`：移除。

## 10. 页面

- **仓库详情页 `/repos/:id`**：新增「受信账号」卡片。说明文字：对仓库有写权限的成员默认可信，这里额外放行没有写权限的账号；bot 与 workling 自身评论永远不算指令。输入框接受用户名或主页链接，列表显示用户名、ID 和移除按钮；错误信息就地显示。非 GitHub 仓库显示"暂只支持 GitHub"并禁用输入。
- **Issue 详情页 `/issues/:id`**：新增「反馈」区块，按时间列出：来源、作者、可信判定、是否算作指令（`observed` 显示为"指令（仅观察）"）、指令文字或正文摘要（前 200 字）、文件与行号、跳转原评论的链接。没有反馈时显示空状态。正文按纯文本渲染，不解析 Markdown/HTML。

## 11. 测试

- 用命令替身覆盖：游标首次建立不回溯；5 分钟重叠去重；Issue 评论与 PR 对话区评论按编号区分；非 workling 条目丢弃；行内评论的 path/line；reviews 跳过 PENDING 与观察开始前的记录；编辑后重新判定指令；失败时不更新游标。
- 可信判定：带标记 → `self`；`type: Bot` → `bot`；名单命中 → `allowlist`；写权限 → `write`，权限查询缓存生效；404 → `untrusted`。
- 指令判定：两种前缀、前缀后需空白、正文中间的前缀不算、不可信作者带前缀仍为 false、`CHANGES_REQUESTED` 无前缀为 true。
- 受信账号接口：用户名 / `@` / 主页链接三种输入、host 不一致、用户不存在、重复添加、非 GitHub 仓库。
- workling 发出的评论都带标记。

## 12. 不做

- 不触发任何运行、不回复、不改标签；`src/serve/retry.ts`（失败后指令重试）的行为保持不变。
- 指令前缀可配置、默认改为 `@workling-agent`：另开 Issue。
- GitLab 实现、ETag 条件请求、全局受信名单、历史评论回溯。
