# 仓库开发约定

本文件面向维护 workling 源码的开发者与 Agent。项目概览、配置与部署见 [README.zh-CN.md](README.zh-CN.md)。

## 边界

- watch 监听 Issue、入队、以独立进程拉起 task 并对账，是唯一更新状态标签的一方；task 在本地克隆业务仓库并拉起 Pi，结果写 `result.json`，不改标签。
- Pi 组装 Issue 中的提示词并调用 codex-cli；codex 只改文件并写回报文档，提交、推送、PR 与回复由 Pi 完成。不自研 agent。
- 隔离逐步加强：不加外层沙箱 → 用 `codex sandbox` 包住整个 task → 每个任务一个容器。
- 用户可见状态放平台标签与评论。自建服务与数据库按需引入（Hono + SQLite/Drizzle），不预建框架。
- 变更保持聚焦，不附带大范围重构或工具链替换。

## 代码

- 使用 Bun、严格 TypeScript、Oxfmt 和 Oxlint；格式交给工具。
- 按业务顺序写清流程；只抽取已有重复或有独立语义的部分，不为每个函数增加 service/class/interface。
- 注释说明原因、边界和安全约束，不复述代码。
- 环境变量、JSON、Issue 正文等外部输入先做形状校验；类型断言不是运行时校验。
- 外部依赖在 `Command`（`src/runtime/types.ts`）、fetch 等边界替换，不引入 DI 框架。
- 源自 pi-workbot（MIT）的文件在文件头保留来源说明。
- 表结构改动用 drizzle 迁移（`bun run db:generate`）；一次性数据 / 文件处理写成 `src/upgrade/steps/` 下的升级步骤，必须可重复执行，见该目录 README。

## 测试

- 用例名说明场景和行为；断言留在用例正文。
- 快速错误分支用命令替身；关键连接处保留真实子进程、临时目录与本地 bare Git。不用真实模型或业务仓库做单元测试依赖。
- 测试会修改全局环境，保持串行，不用 `test.concurrent`。`test/setup.ts` 负责清理与恢复环境变量。

## 验证

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

使用 `bun run format` 格式化。最终报告区分已验证与未验证。

## 提交

- 提交信息（标题与正文）一律用英文：标题用祈使句、首字母大写、不加句号，控制在 72 个字符内；正文说明改动原因与影响。
