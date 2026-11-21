import { writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Command, Environment } from '../runtime/types.ts'
import type { ExecutorSettings } from '../config/executor.ts'
import { checkDockerHost, hostPathOf } from './docker-host.ts'
import type { Executor } from './index.ts'

// worker 默认放在单独的网络里，不与主体或其他容器共享 compose 网络；enable_icc=false 依赖 Docker 的
// iptables 规则禁止同网段容器互访（Linux 上生效，Docker Desktop 实测不生效）。仍可出网访问 LLM 与包管理源；
// 主体只监听宿主机 127.0.0.1，Linux bridge 网络中的容器访问不到宿主机回环地址上的管理端口。
export const DEFAULT_WORKER_NETWORK = 'workling-worker'

async function ensureWorkerNetwork(command: Command): Promise<void> {
  try {
    await command(['docker', 'network', 'inspect', DEFAULT_WORKER_NETWORK], { quietStderr: true })
    return
  } catch {
    // 不存在时创建；并发创建失败时再确认一次。
  }
  try {
    await command(
      [
        'docker',
        'network',
        'create',
        '--driver',
        'bridge',
        '--opt',
        'com.docker.network.bridge.enable_icc=false',
        '--label',
        'io.workling.network=worker',
        DEFAULT_WORKER_NETWORK,
      ],
      { quietStderr: true },
    )
  } catch (error) {
    await command(['docker', 'network', 'inspect', DEFAULT_WORKER_NETWORK], {
      quietStderr: true,
    }).catch(() => {
      throw error
    })
  }
}

export function dockerExecutor({
  command,
  config,
  log,
  hostPath = (path) => hostPathOf(command, path),
}: {
  command: Command
  config: ExecutorSettings
  log: (message: string) => void
  /** 把任务目录换算成宿主机路径；测试替换它，避免结果取决于测试本身是否跑在容器里。 */
  hostPath?: (path: string) => Promise<string>
}): Executor {
  return {
    async start(spec) {
      const host = await checkDockerHost(command)
      if (host.error) throw new Error(host.error)
      // rootless 时容器内的 root 映射为运行 Docker 的宿主机用户，任务目录的属主才保持一致；
      // 若改用宿主机 uid，会被映射到 subuid，主体无法清理 worker 写下的文件。
      const user = host.rootless ? '0:0' : `${process.getuid!()}:${process.getgid!()}`
      const source = await hostPath(spec.taskDir)
      const network = config.taskNetwork ?? DEFAULT_WORKER_NETWORK
      if (!config.taskNetwork) await ensureWorkerNetwork(command)
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
          user,
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
          '--network',
          network,
          '-v',
          `${source}:${inner}`,
          ...variables.flatMap((key) => ['-e', key]),
          config.taskImage,
          'bun',
          '--no-env-file',
          'worker/cli.ts',
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
