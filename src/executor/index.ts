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

export function workerEnv(base: Environment): Environment {
  const env = { ...base }
  const allowed = new Set([
    'WORKLING_WORKSPACE',
    'WORKLING_CODEX_SANDBOX',
    'WORKLING_TASK_TEE',
    'WORKLING_GITLAB_HOST',
  ])
  // worker 会运行第三方代码和模型生成的命令，不应获得平台凭证或主体配置。
  for (const name of Object.keys(env)) {
    if (/^(GH_|GITHUB_|GITLAB_)/.test(name) || (name.startsWith('WORKLING_') && !allowed.has(name)))
      delete env[name]
  }
  return env
}

export function createExecutor(
  config: ExecutorSettings,
  command: Command,
  log: (message: string) => void = console.error,
  hostPath?: (path: string) => Promise<string>,
): Executor {
  const process = processExecutor()
  const docker = dockerExecutor({ command, config, log, hostPath })
  // 切换执行器后，进行中的运行仍须由启动它的执行器管理。
  const forRun = (run: RunHandle) => (run.container !== null ? docker : process)
  return {
    start: (spec) => (config.sandbox === 'docker' ? docker : process).start(spec),
    status: (run) => forRun(run).status(run),
    signal: (run, signal) => forRun(run).signal(run, signal),
    finish: (run) => forRun(run).finish(run),
  }
}
