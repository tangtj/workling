# plan-notes

这个拆解样例用一个最小的 TypeScript 笔记库练习「粗需求 → 设计文档 → 子 Issue」。准备目录、配置 LLM 后运行 worker：

```sh
workling-worker prepare plan-notes ./notes-run
workling-worker run ./notes-run
```

运行后查看 `notes-run/out/plan.json` 和 `notes-run/repo` 任务分支上的文档提交，人工核对以下预期：

- 清单按顺序列出 2–3 个子 Issue，例如「数据结构与增删标签 → 按标签筛选 → 导出导入保留标签」。
- 设计文档位于 `docs/tasks/001-<短名>/`。「受影响的已有功能」说明导出和导入的兼容性，旧格式（没有标签字段）的 JSON 仍能导入。
- 至少一个子 Issue 的「验收」有旧格式 JSON 导入的回归检查。
- 子 Issue 正文没有 `分支：` 行。
