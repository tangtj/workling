# resolve-conflict

模拟接续运行：任务分支 `workling/4-greeting` 上已有实现提交，合并目标 `main` 在分叉后改了同一处代码，最新补充说明是「解决冲突」。用来观察 Pi 是否自己合并并解决冲突，而不是调用 codex。

```sh
workling-worker prepare resolve-conflict /tmp/run-conflict
workling-worker run /tmp/run-conflict
```

预期：

- `/tmp/run-conflict/pi-events.jsonl` 中没有 `codex exec` 调用。
- `repo/` 的任务分支上多出一个合并 `origin/main` 的提交，`greet` 同时保留自定义问候语和空名字处理，`bun test` 通过。
- `out/outcome.json` 的 `executor` 为 `pi`，`out/pr-comment.md` 含 `## Pi 直接修改`，任务目录下有 `report.md`。
