import { CONTRACT_VERSION } from '../contract/spec.ts'
import type { Command } from '../runtime/types.ts'

export const CONTRACT_LABEL = 'io.workling.contract'

/**
 * worker 镜像可以单独发版，拉起前按镜像标签确认契约版本一致。
 * 返回 null 表示兼容，否则返回给人看的原因；不兼容时不拉起，避免运行到一半才因契约不符失败。
 */
export async function checkWorkerImage(command: Command, image: string): Promise<string | null> {
  let raw: string
  try {
    raw = await command(
      ['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image],
      {
        quietStderr: true,
      },
    )
  } catch {
    return `找不到 worker 镜像 ${image}，请先构建（docker build -f worker/Dockerfile -t ${image} .）或拉取`
  }
  let labels: unknown
  try {
    labels = JSON.parse(raw)
  } catch {
    return `无法读取 worker 镜像 ${image} 的标签`
  }
  const value =
    labels !== null && typeof labels === 'object' && CONTRACT_LABEL in labels
      ? (labels as Record<string, unknown>)[CONTRACT_LABEL]
      : undefined
  if (typeof value !== 'string' || !value)
    return `worker 镜像 ${image} 没有声明契约版本（${CONTRACT_LABEL}），请用 worker/Dockerfile 重新构建`
  if (value !== String(CONTRACT_VERSION))
    return `worker 镜像 ${image} 的契约版本为 ${value}，主体需要 ${CONTRACT_VERSION}；请更换与主体匹配的 worker 镜像`
  return null
}

/**
 * 镜像不在本机时拉取一次（同一进程内每个镜像只尝试一次，避免每轮阻塞在失败的拉取上），然后再检查契约版本。
 */
export async function ensureWorkerImage(
  command: Command,
  image: string,
  attempted: Set<string>,
  log: (message: string) => void,
): Promise<string | null> {
  const error = await checkWorkerImage(command, image)
  if (!error?.startsWith('找不到 worker 镜像') || attempted.has(image)) return error
  attempted.add(image)
  log(`拉取 worker 镜像 ${image}`)
  try {
    await command(['docker', 'pull', '--quiet', image], { quietStderr: true })
  } catch {
    return `拉取 worker 镜像 ${image} 失败；私有镜像需先在宿主机 docker login，或在设置页改为可用的任务镜像`
  }
  return checkWorkerImage(command, image)
}
