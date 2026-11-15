import type { Command, Environment } from '../runtime/types.ts'
import type { ExecutorSettings } from '../config/executor.ts'
import { processExecutor } from './process.ts'
import { dockerExecutor } from './docker.ts'

export type RunHandle = { pid: number | null; container: string | null; taskDir: string }

export interface StartSpec {
  runId: number
  ref: string
  taskDir: string
  env: Environment
}

export interface Executor {
  start(spec: StartSpec): Promise<{ pid?: number; container?: string }>
  status(run: RunHandle): Promise<{ running: boolean; oom?: boolean }>
  signal(run: RunHandle, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  finish(run: RunHandle): Promise<void>
}

export function createExecutor(
  config: ExecutorSettings,
  command: Command,
  log: (message: string) => void = console.error,
): Executor {
  const process = processExecutor()
  const docker = dockerExecutor({ command, config, log })
  // 切换执行器后，进行中的运行仍须由启动它的执行器管理。
  const forRun = (run: RunHandle) => (run.container !== null ? docker : process)
  return {
    start: (spec) => (config.sandbox === 'docker' ? docker : process).start(spec),
    status: (run) => forRun(run).status(run),
    signal: (run, signal) => forRun(run).signal(run, signal),
    finish: (run) => forRun(run).finish(run),
  }
}
