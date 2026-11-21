import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { relative } from 'node:path'
import type { Command } from '../runtime/types.ts'

export type DockerHost = { rootless: boolean; error: string | null }

/**
 * 读取 docker info 判断 worker 容器的隔离条件。
 * - 支持内存、CPU 配额、进程数限制（rootless 另需 cgroup v2）：否则 --memory / --cpus / --pids-limit 会被静默忽略，判为不可用。
 * - rootless：容器内的 root 只映射到宿主机的普通用户。不是 rootless 时仍可运行，但由调用方提示风险。
 * 连接的 Docker 由 DOCKER_HOST 决定，rootless 时通常是 unix:///run/user/<uid>/docker.sock。
 */
export async function checkDockerHost(command: Command): Promise<DockerHost> {
  let raw: string
  try {
    raw = await command(['docker', 'info', '--format', '{{json .}}'], { quietStderr: true })
  } catch {
    return { rootless: false, error: '无法连接 Docker（检查 DOCKER_HOST 与 Docker 服务）' }
  }
  return parseDockerInfo(raw)
}

export function parseDockerInfo(raw: string): DockerHost {
  let info: unknown
  try {
    info = JSON.parse(raw)
  } catch {
    return { rootless: false, error: '无法解析 docker info 的输出' }
  }
  if (info === null || typeof info !== 'object')
    return { rootless: false, error: '无法解析 docker info 的输出' }
  const field = (name: string): unknown => (info as Record<string, unknown>)[name]
  const options = field('SecurityOptions')
  const rootless =
    Array.isArray(options) &&
    options.some(
      (option) => typeof option === 'string' && option.split(',').includes('name=rootless'),
    )
  // rootless 只有在 cgroup v2 下才能通过委派获得资源限制；rootful Docker 在 v1 上也支持这些限制。
  if (rootless && field('CgroupVersion') !== '2')
    return {
      rootless,
      error: `Docker 使用 cgroup v${String(field('CgroupVersion') ?? '?')}，rootless 下 worker 需要 cgroup v2`,
    }
  const missing = [
    ['MemoryLimit', '内存'],
    ['CpuCfsQuota', 'CPU 配额'],
    ['PidsLimit', '进程数'],
  ]
    .filter(([name]) => field(name!) !== true)
    .map(([, label]) => label)
  if (missing.length)
    return {
      rootless,
      error: `Docker 不支持${missing.join('、')}限制${rootless ? '（rootless 需要为用户委派 cgroup 控制器）' : ''}`,
    }
  return { rootless, error: null }
}

/**
 * docker run -v 的源路径由宿主机上的 Docker 解析。主体自己跑在容器里（compose 部署）时，
 * 任务目录在容器内的路径与宿主机不同：读取本容器的挂载，把容器内路径换算成宿主机路径（命名卷时是卷的数据目录）。
 * 不在容器里时原样返回。
 */
export async function hostPathOf(
  command: Command,
  path: string,
  inContainer = existsSync('/.dockerenv'),
  container = hostname(),
): Promise<string> {
  if (!inContainer) return path
  let raw: string
  try {
    raw = await command(['docker', 'inspect', '--format', '{{json .Mounts}}', container], {
      quietStderr: true,
    })
  } catch {
    throw new Error(`无法读取主体容器 ${container} 的挂载信息，不能确定任务目录在宿主机上的路径`)
  }
  let mounts: unknown
  try {
    mounts = JSON.parse(raw)
  } catch {
    mounts = null
  }
  const best = (Array.isArray(mounts) ? mounts : [])
    .filter(
      (mount): mount is { Source: string; Destination: string } =>
        mount !== null &&
        typeof mount === 'object' &&
        typeof (mount as Record<string, unknown>).Source === 'string' &&
        typeof (mount as Record<string, unknown>).Destination === 'string',
    )
    .filter((mount) => {
      const rest = relative(mount.Destination, path)
      return rest === '' || (!rest.startsWith('..') && !rest.startsWith('/'))
    })
    .sort((a, b) => b.Destination.length - a.Destination.length)[0]
  if (!best) throw new Error(`任务目录 ${path} 不在主体容器的挂载卷里，worker 容器无法挂载它`)
  const rest = relative(best.Destination, path)
  return rest ? `${best.Source}/${rest}` : best.Source
}
