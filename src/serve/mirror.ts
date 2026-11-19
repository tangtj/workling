import { chmod, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ghEnv } from '../platform/github.ts'
import type { Command } from '../runtime/types.ts'

export async function syncMirror({
  workspace,
  repo,
  command,
  signal,
}: {
  workspace: string
  repo: { host: string; path: string; token: string }
  command: Command
  signal: AbortSignal
}): Promise<string> {
  const parts = repo.path.split('/')
  if (
    repo.host !== 'github.com' ||
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  )
    throw new Error('镜像只支持 github.com 的 owner/repo 路径')
  signal.throwIfAborted()
  const dir = resolve(workspace, 'mirrors', repo.host, `${repo.path}.git`)
  const options = { cwd: dir, signal }
  // 同一个 serve 进程内，launchQueued 逐个准备任务，同一时间只有一次镜像操作。
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  if (
    !(await stat(join(dir, 'HEAD'), { throwIfNoEntry: false }))?.isFile() ||
    !(await stat(join(dir, 'config'), { throwIfNoEntry: false }))?.isFile() ||
    !(await stat(join(dir, 'objects'), { throwIfNoEntry: false }))?.isDirectory()
  )
    await command(['git', 'init', '--bare', '.'], options)
  const remotes = await command(['git', 'remote'], options)
  await command(
    [
      'git',
      'remote',
      remotes.split('\n').includes('origin') ? 'set-url' : 'add',
      'origin',
      `https://${repo.host}/${repo.path}.git`,
    ],
    options,
  )
  await command(
    ['git', 'config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
    options,
  )

  const timeout = AbortSignal.timeout(10 * 60_000)
  try {
    await command(
      [
        'git',
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'fetch',
        '--prune',
        '--tags',
        'origin',
      ],
      { cwd: dir, env: ghEnv(repo.token, repo.host), signal: AbortSignal.any([signal, timeout]) },
    )
  } catch (cause) {
    if (timeout.aborted && !signal.aborted) throw new Error('同步仓库镜像超时', { cause })
    throw cause
  }
  return dir
}
