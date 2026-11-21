import type { Command } from '../runtime/types.ts'

export type DockerHost = { rootless: boolean; error: string | null }

/**
 * 读取 docker info 判断 worker 容器的隔离条件。
 * - cgroup v2 且支持内存、CPU 配额、进程数限制：否则 --memory / --cpus / --pids-limit 会被静默忽略，判为不可用。
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
  if (field('CgroupVersion') !== '2')
    return {
      rootless,
      error: `Docker 使用 cgroup v${String(field('CgroupVersion') ?? '?')}，worker 需要 cgroup v2`,
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
