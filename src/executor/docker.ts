import { writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Command, Environment } from '../runtime/types.ts'
import type { ExecutorSettings } from '../config/executor.ts'
import type { Executor } from './index.ts'

export function dockerExecutor({
  command,
  config,
  log,
}: {
  command: Command
  config: ExecutorSettings
  log: (message: string) => void
}): Executor {
  return {
    async start(spec) {
      const name = `workling-run-${spec.runId}`
      const inner = `/data/tasks/${basename(spec.taskDir)}`
      await mkdir(join(spec.taskDir, 'home'), { mode: 0o700 })
      const env: Environment = {
        ...spec.env,
        HOME: `${inner}/home`,
        WORKLING_WORKSPACE: '/data',
        WORKLING_CODEX_SANDBOX: 'danger-full-access',
        WORKLING_TASK_TEE: '1',
      }
      const variables = [
        'HOME',
        'WORKLING_WORKSPACE',
        'WORKLING_CODEX_SANDBOX',
        'WORKLING_TASK_TEE',
        'WORKLING_GITLAB_HOST',
      ].filter((key) => env[key])
      await command(
        [
          'docker',
          'run',
          '-d',
          '--name',
          name,
          '--label',
          `workling.run=${spec.runId}`,
          '--label',
          `workling.issue=${spec.ref}`,
          '--init',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          String(config.taskCpus),
          '--memory',
          config.taskMemory,
          '--pids-limit',
          String(config.taskPids),
          ...(config.taskNetwork ? ['--network', config.taskNetwork] : []),
          '-v',
          `${spec.taskDir}:${inner}`,
          ...variables.flatMap((key) => ['-e', key]),
          config.taskImage,
          'bun',
          '--no-env-file',
          'src/cli.ts',
          'task',
          spec.ref,
          inner,
        ],
        { env },
      )
      return { container: name }
    },
    async status(run) {
      if (!run.container) return { running: false }
      try {
        const output = await command([
          'docker',
          'inspect',
          '-f',
          '{{.State.Running}} {{.State.OOMKilled}}',
          run.container,
        ])
        return {
          running: output.startsWith('true'),
          ...(output.trim() === 'false true' ? { oom: true } : {}),
        }
      } catch {
        return { running: false }
      }
    },
    async signal(run, signal) {
      if (!run.container) return
      try {
        await command(['docker', 'kill', '-s', signal, run.container])
      } catch (error) {
        try {
          await command(['docker', 'inspect', run.container])
        } catch {
          return
        }
        throw error
      }
    },
    async finish(run) {
      if (!run.container) return
      try {
        // Command 默认继承 stderr；固定脚本把 Docker 的两个日志流合并，容器名作为参数传递。
        const output = await command(['sh', '-c', 'docker logs "$1" 2>&1', 'sh', run.container])
        await writeFile(join(run.taskDir, 'container.log'), output)
      } catch (error) {
        log(
          `${run.container} 收集日志失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        await command(['docker', 'rm', '-f', run.container])
      } catch (error) {
        log(
          `${run.container} 删除容器失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
