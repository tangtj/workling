# 升级步骤

表结构变化使用 drizzle 迁移，通过 `bun run db:generate` 生成；一次性数据或文件处理使用本目录的升级步骤。不要在步骤里调用网络（包括 GitHub、LLM）。

一个步骤一个 `.ts` 文件，命名为 `v<主>.<次>.<修订>-<两位序号>-<短名>.ts`，例如 `v0.3.0-01-move-task-logs.ts`。版本的三个部分为数字，序号固定两位，短名只含小写字母、数字和连字符。按版本号数值顺序、再按序号执行，同版本的序号不能重复。加载器忽略非 `.ts` 文件、`_` 开头的文件和 `.test.ts` 文件。

每个步骤导出非空中文说明 `description` 和异步函数 `run(ctx: UpgradeContext): Promise<void>`。`ctx` 包含：

- `db`：已完成 drizzle 迁移的 `WorklingDatabase`。
- `workspace`：当前工作目录（服务数据目录）的绝对路径。
- `log(message)`：启动日志输出函数。

serve 启动时，在 `openDatabase`（含 drizzle 迁移）之后、Pi / 执行器配置导入、密码初始化和对账之前执行步骤。每步成功后单独在 `upgrade_steps` 表登记文件名（去掉 `.ts`）、说明与时间，后续启动跳过已登记步骤。不要改名或改写已发布步骤，后续处理应新增步骤。

步骤失败会记录错误并中止服务启动，失败步骤不登记，之前成功的记录保留。Docker 下连续 3 次启动失败会自动回滚并恢复升级前的数据库备份；systemd 下启动失败需人工处理。没有步骤回滚函数。

步骤必须幂等、可安全重复执行：进程可能在执行一半或成功但尚未登记时被结束，下次启动会再次执行。文件操作不能通过数据库事务回滚，因此所有步骤不共用一个大事务。

模板仅作编写参考，不作为真实步骤发布：

```ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpgradeContext } from '../index.ts'

export const description = '创建任务归档目录'

export async function run(ctx: UpgradeContext): Promise<void> {
  // recursive 允许目录已存在，进程中途退出后重复执行仍然安全。
  await mkdir(join(ctx.workspace, 'task-archive'), { recursive: true })
}
```
