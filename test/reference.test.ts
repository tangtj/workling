import { describe, expect, test } from 'bun:test'
import { parseIssueRef } from '../src/issue/reference.ts'

describe('Issue 引用解析', () => {
  test('解析 GitHub 简写', () => {
    expect(parseIssueRef('github:owner/repo#12')).toEqual({
      platform: 'github',
      host: 'github.com',
      project: 'owner/repo',
      iid: 12,
    })
  })

  test('解析指定 GitLab host 的简写', () => {
    expect(parseIssueRef('gitlab:group/sub/proj#3', 'gitlab.example.com')).toEqual({
      platform: 'gitlab',
      host: 'gitlab.example.com',
      project: 'group/sub/proj',
      iid: 3,
    })
  })

  test('解析 GitHub URL 并忽略尾斜线、查询和 hash', () => {
    expect(
      parseIssueRef('https://github.com/owner/repo/issues/12/?tab=all#issuecomment-1'),
    ).toEqual({
      platform: 'github',
      host: 'github.com',
      project: 'owner/repo',
      iid: 12,
    })
  })

  test('解析任意 host 的 GitLab URL', () => {
    expect(parseIssueRef('https://git.example.com/group/sub/proj/-/issues/3')).toEqual({
      platform: 'gitlab',
      host: 'git.example.com',
      project: 'group/sub/proj',
      iid: 3,
    })
  })

  test.each([
    'owner/repo#1',
    'github:a/b/c#1',
    'gitlab:proj#1',
    'github:a/b#0',
    'github:a/b#01',
    'ftp://github.com/a/b/issues/1',
    'https://github.com/a/b/pull/1',
  ])('拒绝无效引用 %s', (input) => {
    expect(() => parseIssueRef(input)).toThrow(`无法识别的 Issue 引用：${input}`)
  })
})

describe('仓库引用解析', () => {
  test('解析和格式化 GitHub 与 GitLab 仓库', async () => {
    const { parseRepoRef, formatRepoRef } = await import('../src/issue/reference.ts')
    expect(parseRepoRef('https://github.com/owner/repo.git/')).toEqual({
      platform: 'github',
      host: 'github.com',
      path: 'owner/repo',
    })
    expect(formatRepoRef(parseRepoRef('gitlab:group/sub/proj', 'git.example.com'))).toBe(
      'gitlab:group/sub/proj',
    )
    expect(parseRepoRef('https://git.example.com/group/sub/proj', 'git.example.com').host).toBe(
      'git.example.com',
    )
  })
  test.each(['github:a', 'github:a/b/c', 'https://evil.com/a/b', 'http://github.com/a/b'])(
    '拒绝无效仓库引用 %s',
    async (input) => {
      const { parseRepoRef } = await import('../src/issue/reference.ts')
      expect(() => parseRepoRef(input)).toThrow(`无法识别的仓库引用：${input}`)
    },
  )
})
