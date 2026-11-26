# 接入 workling

本文写给业务仓库里的 AI 编码助手（也可由人照做）。用户说「按本文把这个仓库接入 workling」或「按本文更新 workling 接入文档」时，在**当前业务仓库**执行以下步骤。

接入后，开发类实现任务改为：本地写需求与设计文档、建 Issue，由 workling 实现并发起 PR。日常使用只读业务仓库内的文件，不再依赖本文。

## 要写入的文件

按下列地址取原文，写入业务仓库对应位置：

1. 主文档，固定写入 `docs/workling.md`（AGENTS.md 规则与 Issue 模板都指向这个路径）：
   https://raw.githubusercontent.com/tangtj/workling/main/templates/repo/docs/workling.md
2. 两行常驻规则，追加到 `AGENTS.md`：
   https://raw.githubusercontent.com/tangtj/workling/main/templates/repo/AGENTS.snippet.md
3. 网页手写 Issue 的模板，写入 `.github/ISSUE_TEMPLATE/workling.md`：
   https://raw.githubusercontent.com/tangtj/workling/main/templates/repo/.github/ISSUE_TEMPLATE/workling.md

4. 网页手写需求的模板，写入 `.github/ISSUE_TEMPLATE/workling-plan.md`：
   https://raw.githubusercontent.com/tangtj/workling/main/templates/repo/.github/ISSUE_TEMPLATE/workling-plan.md

## 步骤

1. **检查状态**：workling 目前只支持 GitHub，`git remote get-url origin` 不是 github.com 仓库时告诉用户并停止。在业务仓库根目录确认工作区干净（`git status`），记下默认分支。若 `docs/workling.md` 已存在，读出首行的 `v<数字>` 版本标记，按「更新」处理。
2. **新建分支**：`git fetch origin && git switch -c chore/workling-setup origin/<默认分支>`。不要直接向默认分支提交。
3. **写入文件**：按「要写入的文件」中的地址取原文写入。
   - `AGENTS.md`：把片段追加到文件末尾（或仓库已有的「约定 / 规则」列表中），保留片段首行的版本注释；文件不存在时新建，只含这段内容。
   - `docs/` 被 `.gitignore` 忽略时告诉用户，不要强行提交。
4. **填写「本仓库约定」**：阅读业务仓库的 AGENTS.md / README / CI 配置，填 `docs/workling.md` 末尾一节：默认分支、文档目录、检查命令、其他约定。只写能从仓库确认的内容，拿不准的问用户，不要编造。
5. **自查**：文件中没有残留 `<...>` 占位（「Issue 正文格式」代码块中的占位除外）；没有写入任何 token、个人或公司信息。
6. **提交并发起 PR**：按仓库提交规范提交，推送分支，`gh pr create` 发起接入 PR，正文列出写入的文件与「本仓库约定」的填写依据。把 PR 链接交给用户。

## 更新

已接入的仓库再次执行时：

- 对比版本标记。版本相同且内容一致则告诉用户已是最新，不做改动。
- 用新模板替换 `docs/workling.md` 的通用部分，**保留「本仓库约定」一节的原有内容**；新模板在该节新增了条目时，按第 4 步补填。
- `AGENTS.md` 中带 `workling 接入` 注释的片段整体替换为新片段，不要重复追加。
- Issue 模板直接替换（仓库对它有自定义修改时先问用户）。
- 同样走新分支和 PR。

## 接入之外还需要

- 运行 workling 的一方在管理页「仓库」中登记本仓库并配置 token，workling 会创建 `workling:*` 标签。没登记时打 `workling:ready` 不会有任何反应。
- 开发者本地需要已登录的 `gh`，不需要安装 workling。
