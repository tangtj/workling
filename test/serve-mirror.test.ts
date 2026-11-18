import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from '../src/runtime/types.ts'
import { syncMirror } from '../src/serve/mirror.ts'
import { localRemote } from './helpers/git.ts'

test.each([
  ['调用方中止', '调用方中止'],
  ['fetch 超时', '同步仓库镜像超时'],
] as const)('同步镜像时传播%s', async (kind, error) => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-mirror-'))
  const controller = new AbortController()
  const deadline = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  try {
    await expect(
      syncMirror({
        workspace,
        repo: { host: 'github.com', path: 'a/b', token: 'test-token' },
        signal: controller.signal,
        command: async (args, options) => {
          if (!args.includes('fetch')) return ''
          const abort = kind === '调用方中止' ? controller : deadline
          abort.abort(new Error(kind))
          options?.signal?.throwIfAborted()
          return ''
        },
      }),
    ).rejects.toThrow(error)
    expect(timeout).toHaveBeenCalledWith(10 * 60_000)
  } finally {
    timeout.mockRestore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('真实 Git：首次同步与重试只保留分支和标签，并更新提交、清除已删除分支', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-mirror-'))
  try {
    const remote = await localRemote(workspace)
    const main = await remote.commit('refs/heads/main', 'first')
    await remote.write(['update-ref', 'refs/heads/removed', main])
    await remote.write(['update-ref', 'refs/tags/v1', main])
    await remote.write(['update-ref', 'refs/pull/1/head', main])
    let fetches = 0
    const command: Command = async (args, options) => {
      if (args.includes('fetch')) {
        expect(args.slice(1)).toEqual([
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!gh auth git-credential',
          'fetch',
          '--prune',
          '--tags',
          'origin',
        ])
        expect(options?.env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'test-token' })
        if (++fetches === 1) throw new Error('模拟 fetch 失败')
      }
      return remote.git(args, options)
    }
    const options = {
      workspace,
      repo: { host: 'github.com', path: 'a/b', token: 'test-token' },
      command,
      signal: new AbortController().signal,
    }
    await expect(syncMirror(options)).rejects.toThrow('模拟 fetch 失败')
    const mirror = join(workspace, 'mirrors/github.com/a/b.git')
    const git = (args: string[]) => remote.git(['git', ...args], { cwd: mirror })
    expect(await git(['remote', 'get-url', 'origin'])).toBe(`file://${remote.path}`)
    expect(await syncMirror(options)).toBe(mirror)
    expect((await stat(mirror)).mode & 0o777).toBe(0o700)
    expect(await git(['for-each-ref', '--format=%(refname)'])).toBe(
      'refs/heads/main\nrefs/heads/removed\nrefs/tags/v1',
    )
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(main)
    const next = await remote.commit('refs/heads/main', 'second', main)
    await remote.write(['update-ref', '-d', 'refs/heads/removed'])
    expect(await syncMirror(options)).toBe(mirror)
    expect(fetches).toBe(3)
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(next)
    expect(await git(['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main\nrefs/tags/v1')
    const config = await readFile(join(mirror, 'config'), 'utf8')
    expect(config).toContain('https://github.com/a/b.git')
    expect(config).not.toMatch(/credential|test-token/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
