<!-- workling 接入文档 v1，来源 https://github.com/tangtj/workling/tree/main/templates -->

# 用 workling 推进开发

本仓库的开发类实现任务交给 [workling](https://github.com/tangtj/workling) 执行：人和本地 AI 只负责把需求与设计写清楚、建 Issue；workling 监听带 `workling:ready` 标签的 Issue，由 codex 实现，再提交、推送、建 PR 并在 Issue 下回复。

## 本地 AI 的职责

- **做**：整理需求、写设计文档、建 Issue，把 Issue 链接交给用户。
- **不做**：修改业务代码或跑实现；替 workling 建实现 PR；向默认分支提交或推送；打或改 `workling:*` 标签。
- 建 Issue 时**不打标签**。用户在 GitHub 上看过 Issue 后自己打 `workling:ready`，打上之后才会开始执行。
- 用户明确要求在本地直接实现时，按用户要求来，不受本文约束。

## 选择方式

| 方式                       | 适用场景                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| **简单：只写 Issue**       | 一份说明就能讲清：改动集中、文件不多、没有需要单独评审的设计             |
| **复杂：文档分支 + Issue** | 需要多份文档（方案、接口、迁移、验收清单等），或文档要先评审、随 PR 合入 |

拿不准时问用户。

### 简单方式

1. 按下方「Issue 正文格式」写正文，存到临时文件。
2. 建 Issue：`gh issue create --title "<标题>" --body-file <正文文件>`。
3. 把 Issue 链接交给用户，提醒打上 `workling:ready`。

### 复杂方式

1. 从最新默认分支切出文档分支：`git fetch origin && git switch -c docs/<短名> origin/<默认分支>`。分支名只用英文字母、数字和 `/ . _ -`。
2. 把文档写到「本仓库约定」中的文档目录。入口文档写目标、范围、验收与其他文档的索引，其余按主题拆分。只提交文档。
3. 按仓库提交规范提交，推送：`git push -u origin docs/<短名>`。用户可能要先审文档，按反馈修改后再推送。
4. 写 Issue 正文，包含 `分支：docs/<短名>` 一行，并在「文档」一节列出要阅读的文档路径。
5. 建 Issue（同简单方式），把 Issue 链接和文档分支交给用户，提醒打上 `workling:ready`。

workling 从文档分支切出任务分支 `workling/<号>-<短名>`，PR 同时包含文档与实现，合入默认分支。文档分支不必另开 PR，PR 合并后可删除。

## Issue 正文格式

正文会原样交给 codex，要能独立读懂，不要写「见上面讨论」这类依赖上下文的话。

```md
## 目标

<要达成什么，为什么>

## 范围

- <改哪些模块 / 文件，新增或修改哪些行为>

## 验收

- [ ] <可检查的结果：命令、测试、页面表现>

## 不做

- <明确排除的内容>

## 文档

<复杂方式必填：要阅读的仓库内文档路径，每行一个；简单方式删除本节>

分支：<复杂方式必填，如 docs/<短名>；简单方式删除本行>
模型：<可选，覆盖默认 codex 模型>
强度：<可选，覆盖默认推理强度>
```

`分支：`、`模型：`、`强度：` 各占一行，冒号用中文全角冒号。

## 状态与返工

- workling 的提交署名为 Workling（GitHub 机器账号 [workling-agent](https://github.com/workling-agent)），作者或 `Co-authored-by` 指向它。
- 进度看 Issue 标签：`workling:queued` → `workling:running` → `workling:done` / `workling:failed`。
- 领取时 workling 会在 Issue 下评论；运行中亲自确认的待办项会勾选，修改勾选状态前先评论说明。
- 失败或要返工：修改 Issue 正文或文档分支上的文档（推送到文档分支），再重新打上 `workling:ready`。
- 接着做：失败、部分完成或 PR 仍开着时，评论 `/workling <补充说明>` 即可在同一条工作分支上继续；workling 会把此前运行的回报、分支提交和 PR 反馈一并交给执行方。只提问不要求改代码时，会直接在 Issue 下答复。
- 从头来：关闭（或合并）PR 后重新打上 `workling:ready`，会从默认分支或文档分支重新切出任务分支。
- 部分完成会建 draft PR，后续运行完成后转为可审查。
- 返工时已勾选的项仍会重新核对。
- 会改同一处代码的 Issue 不要同时就绪，并行 PR 会冲突。

## 本仓库约定

<!-- 以下由接入时按本仓库实际情况填写，更新接入文档时保留 -->

- 默认分支：<main>
- 文档目录：<docs/tasks/<短名>/>
- 检查命令：<如 bun run check；codex 会按仓库 AGENTS.md / README 运行检查>
- 其他：<无>
