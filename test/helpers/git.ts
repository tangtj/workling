import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from '../../src/runtime/process.ts'
import type { Command } from '../../src/runtime/types.ts'

export async function localRemote(workspace: string) {
  const path = join(workspace, 'remote.git')
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  await run(['git', 'init', '--bare', '--initial-branch=main', path], { env })
  const write = (args: string[], input?: string) => run(['git', ...args], { cwd: path, env, input })
  async function commit(ref: string, contents: string, parent?: string) {
    const blob = await write(['hash-object', '-w', '--stdin'], contents)
    const tree = await write(['mktree'], `100644 blob ${blob}\tcontent.txt\n`)
    const sha = await write([
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      contents,
    ])
    await write(['update-ref', ref, sha])
    return sha
  }
  const git: Command = (args, options) =>
    run(
      [
        'git',
        '-c',
        `url.${pathToFileURL(path).href}.insteadOf=https://github.com/a/b.git`,
        ...args.slice(1),
      ],
      { ...options, env: { ...options?.env, ...env } },
    )
  return { path, git, write, commit }
}
