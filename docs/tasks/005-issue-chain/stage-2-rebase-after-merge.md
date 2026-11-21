# 阶段 2：上游合并后自动变基下游 PR

前提：阶段 1 已合入（`runs.stack_branch` 已存在）。

## 问题

本仓库用 squash 合并。上游子任务的 PR 被 squash 合并后，下游 PR 的分支里仍是上游的原始提交：

- 如果上游分支在合并时被删除，GitHub 会把下游 PR 的 base 自动改成默认分支，但 diff 里会混进上游的全部改动；
- 如果上游分支没删，下游 PR 的 base 还指向一个已经合并、不会再变的分支。

## 做法

在 `src/serve/pr-sync.ts` 同步到某个 Issue 的 `prState` **从 open 变为 merged** 时（只在状态变化的那一次触发）：

1. 找下游：同仓库中 `issues.prState === 'open'`，且最近一次 `stack_branch` 非空的 run 的 `stack_branch` 等于刚合并的上游分支（上游最后一次 run 的 `branch`）。
2. 对每个下游，在镜像的临时克隆中执行（参照 `land.ts` 的落地方式，不在镜像本身操作）：
   - `git fetch origin`；
   - `git rebase --onto origin/<默认分支> <下游 run.baseRef> <下游分支>`，只搬下游自己的提交；
   - 成功后执行 `git push --force-with-lease=<下游分支>:<推送前远端 tip> origin <下游分支>`，再执行 `gh pr edit <下游 PR> --base <默认分支>`；
   - 把下游最近一次 run 的 `stack_branch` 置为 null、`base_ref` 更新为 `origin/<默认分支>` 的提交，保证再次变基或返工时的范围计算正确。
   - 在下游 PR 评论：`workling：上游 #<号> 已合并，已将本 PR 变基到 <默认分支>。`
3. 变基冲突：执行 `git rebase --abort`，不推送、不改 base，在下游 Issue 评论：`workling：上游 #<号> 已合并，自动变基到 <默认分支> 时冲突（<冲突文件列表>）。评论 \`/workling 变基到 <默认分支> 并解决冲突\` 可交给 workling 处理。`
4. 下游正在 running 时跳过，并记日志；下一次 pr-sync 不再重试（只在状态变化时触发）。这种情况在评论里提示用户手动处理。

## 验收

- [ ] 本地 bare Git 集成测试：上游分支 squash 合入默认分支后，下游变基成功，新分支只包含下游自己的提交，PR base 被改为默认分支，`stack_branch` 被清空。
- [ ] 冲突场景：不推送、不改 base，评论包含冲突文件。
- [ ] 推送使用 `--force-with-lease` 并指定预期的远端 tip；远端在此期间被改动时推送失败，只记日志。
- [ ] 同一次合并只触发一次（重复 pr-sync 不会重复变基或评论）。
- [ ] `bun run check` 通过。

## 不做

- 上游有返工提交时，不自动把新提交同步给下游。下游 PR 的 diff 以合并基点计算，不受影响。
- 不处理上游 PR 被关闭但未合并的情况（下游门控在阶段 1 已会停下；已开出的下游 PR 由用户自行处理）。
