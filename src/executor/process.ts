import { join } from 'node:path'
import { WORKER_CLI } from '../runtime/paths.ts'
import { isTaskAlive, killGroup, launch } from '../runtime/process.ts'
import type { Launch } from '../runtime/types.ts'
import type { Executor } from './index.ts'

export function processExecutor(options: { launch?: Launch } = {}): Executor {
  return {
    async start(spec) {
      const pid = (options.launch ?? launch)(
        // 禁止 Bun 从共享工作目录的 .env 重新载入主体配置。
        [process.execPath, '--no-env-file', WORKER_CLI, 'task', spec.ref, spec.taskDir],
        { env: spec.env, log: join(spec.taskDir, 'task.log') },
      )
      return { pid }
    },
    async status(run) {
      return { running: run.pid !== null && isTaskAlive(run.pid, run.taskDir) }
    },
    async signal(run, signal) {
      if (run.pid !== null) killGroup(run.pid, signal)
    },
    async finish() {},
  }
}
