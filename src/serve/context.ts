import { and, desc, eq, ne } from 'drizzle-orm'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { readOutputFile, truncateComment } from '../contract/out.ts'
import type { Spec } from '../contract/spec.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback, runs } from '../db/schema.ts'
import { feedbackSourceNames } from './replies.ts'
import { defaultBranch as readDefaultBranch, ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { assertTaskDir } from '../contract/result.ts'
import { redactSecrets } from './secret-scan.ts'

const login = Type.Object({ login: Type.String() })
const prSchema = Type.Object({
  number: Type.Integer(),
  url: Type.String(),
  title: Type.String(),
  body: Type.String(),
  isDraft: Type.Boolean(),
})
const prDetailSchema = Type.Object({
  reviews: Type.Array(
    Type.Object({
      author: login,
      state: Type.String(),
      body: Type.String(),
      submittedAt: Type.String(),
    }),
  ),
  comments: Type.Array(
    Type.Object({ author: login, body: Type.String(), createdAt: Type.String() }),
  ),
  statusCheckRollup: Type.Array(
    Type.Object(
      {
        name: Type.Optional(Type.String()),
        context: Type.Optional(Type.String()),
        conclusion: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  ),
})
const line = Type.Union([Type.Null(), Type.Integer()])
const inlinePagesSchema = Type.Array(
  Type.Array(
    Type.Object({
      user: login,
      path: Type.String(),
      line,
      original_line: line,
      body: Type.String(),
      created_at: Type.String(),
    }),
  ),
)

export async function writeRunContext({
  db,
  taskDir,
  repo,
  issue,
  runId,
  kind = 'implement',
  prUrl,
  checkout,
  chain,
  command,
  secrets,
  log,
}: {
  db: WorklingDatabase
  taskDir: string
  repo: { path: string; host: string; token: string }
  issue: { id: number; number: number }
  runId: number
  kind?: Spec['kind']
  prUrl?: string
  // target 是 PR 最终合入的分支：堆叠时为上游任务分支，否则为默认分支。
  checkout: Spec['repo'] & { start: string; target?: string }
  chain?: {
    parent: number
    title: string
    position: number
    total: number
    kind: 'free' | 'base' | 'stack'
    previous?: number
    branch?: string
  }
  command: Command
  secrets: string[]
  log: (message: string) => void
}): Promise<void> {
  const input = join(taskDir, 'input')
  const redact = (content: string) => redactSecrets(content, secrets)
  const warn = (file: string, error: unknown) =>
    log(redact(`${repo.path} #${issue.number} ${file} 获取失败：${errorMessage(error)}`))
  const git = (...args: string[]) =>
    command(['git', ...args], { cwd: join(taskDir, 'repo'), quietStderr: true })
  const gh = (...args: string[]) =>
    command(['gh', ...args], { env: ghEnv(repo.token, repo.host), quietStderr: true })
  const origin = (branch: string) => `refs/remotes/origin/${branch}`

  async function write(file: string, collect: () => Promise<string>) {
    let content: string
    try {
      content = redact(await collect())
      if (file === 'pr.md' || file === 'feedback.md') content = truncateComment(content)
    } catch (error) {
      warn(file, error)
      content = redact(`获取失败：${errorMessage(error)}`)
    }
    try {
      await mkdir(input, { recursive: true, mode: 0o700 })
      await writeFile(join(input, file), content, { mode: 0o600 })
    } catch (error) {
      warn(file, error)
    }
  }

  async function previousOutput(dir: string, name: string, limit: number) {
    try {
      if (!(await lstat(dir)).isDirectory()) return ''
      const content = redact((await readOutputFile(dir, name, limit * 3, true)).toString('utf8'))
      return content.length > limit
        ? `${content.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')}\n\n（已截断）`
        : content
    } catch {
      return ''
    }
  }

  // 只在对象库里试合并，不改动工作副本；检测不了时不影响其余上下文。
  async function conflicts(ref: string) {
    try {
      await git('merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', ref)
      return '无'
    } catch (error) {
      // 有冲突时退出码为 1，输出第一行是合并结果的 tree，其后每行一个冲突文件。
      const [status, tree, ...files] = errorMessage(error).split('\n')
      const paths = files.filter(Boolean)
      if (status !== 'git 退出码 1' || !/^[0-9a-f]{40,64}$/.test(tree ?? '') || !paths.length)
        return '未能检测'
      return paths.map((path) => `- ${path}`).join('\n')
    }
  }

  if (chain)
    await write('chain.md', async () =>
      [
        '# 子任务位置',
        '',
        `- 主 Issue：#${chain.parent} ${chain.title}`,
        `- 本任务：第 ${chain.position} / ${chain.total} 个子 Issue`,
        ...(chain.kind === 'stack'
          ? [`- 上一个子任务：#${chain.previous}，分支 \`${chain.branch}\`（本任务从该分支切出）`]
          : []),
        ...(chain.kind === 'base' ? [`- 上一个子任务已合并，本任务从 ${checkout.start} 切出`] : []),
        '',
        '只实现本 Issue 的范围；上一个子任务的改动已经在分支里，不要重做或回退。',
      ].join('\n'),
    )

  await write('feedback.md', async () => {
    const rows = db
      .select()
      .from(feedback)
      .where(and(eq(feedback.runId, runId), eq(feedback.status, 'included')))
      .orderBy(feedback.createdAt, feedback.id)
      .all()
    const sections = rows.map((row) => {
      const body = row.isCommand ? (row.instruction ?? row.body) : row.body
      const text =
        body.length > 8000
          ? `${body.slice(0, 8000).replace(/[\uD800-\uDBFF]$/, '')}\n\n（已截断）`
          : body
      return [
        `## F${row.id} · ${feedbackSourceNames[row.source]}${row.reviewState ? `（${row.reviewState}）` : ''} · @${row.authorLogin} · ${row.createdAt.toISOString()}`,
        '',
        ...(row.path ? [`位置：${row.path}:${row.line ?? '未知'}`] : []),
        `链接：${row.url}`,
        '',
        text,
      ].join('\n')
    })
    return [
      '# 本轮反馈',
      '',
      `类型：${kind}`,
      '',
      ...(sections.length ? sections : ['无本轮反馈。']),
    ].join('\n\n')
  })

  await write('runs.md', async () => {
    const previous = db
      .select()
      .from(runs)
      .where(and(eq(runs.issueId, issue.id), ne(runs.id, runId), ne(runs.kind, 'review')))
      .orderBy(desc(runs.id))
      .limit(5)
      .all()
    if (!previous.length) return '无此前运行。'
    const sections: string[] = []
    for (const [index, run] of previous.reverse().entries()) {
      const lines = [
        `## 第 ${index + 1} 次运行 · ${run.startedAt.toISOString()}`,
        `- 结束时间：${run.endedAt?.toISOString() ?? '无'}`,
        `- 结果：${run.reportResult ?? '无'}`,
        `- 错误：${run.error ?? '无'}`,
        `- 分支：${run.branch ?? '无'}`,
        `- 基点：${run.baseRef ?? '无'}`,
      ]
      if (run.taskDir) {
        // 旧任务目录可能已被清理，或被 worker 换成了符号链接。
        try {
          const dir = assertTaskDir(resolve(taskDir, '../..'), run.taskDir)
          if ((await lstat(dir)).isDirectory()) {
            const report = await previousOutput(dir, 'report.md', 20_000)
            if (report) lines.push('', '### 回报', '', report)
            const explanation = await previousOutput(join(dir, 'out'), 'issue-comment.md', 10_000)
            if (explanation) lines.push('', '### Pi 的说明', '', explanation)
          }
        } catch {}
      }
      sections.push(lines.join('\n'))
    }
    return sections.join('\n\n')
  })

  await write('branch.md', async () => {
    const { branch, continued, start, target } = checkout
    const lines = [
      `- 工作分支：${branch}`,
      `- 是否接续：${continued ? '是' : '否'}`,
      `- 起点分支：${start}`,
      ...(target ? [`- 合并目标：${target}`] : []),
    ]
    if (kind === 'review')
      return [...lines, '', `评审范围：git diff ${checkout.baseRef} HEAD`].join('\n')
    if (!continued) return [...lines, '', '本次从起点新建，暂无提交。'].join('\n')
    const ref = origin(start)
    const commits = await git('log', '--oneline', '--no-decorate', '-n', '50', `${ref}..HEAD`)
    const base = await git('merge-base', ref, 'HEAD')
    const stat = (await git('diff', '--stat', `${base}..HEAD`)).split('\n').slice(0, 200).join('\n')
    const ahead = Number(await git('rev-list', '--count', `HEAD..${ref}`))
    lines.push('', '## 提交', '', commits || '无', '', '## 改动统计', '', stat || '无')
    if (ahead > 0) lines.push('', `起点分支在分叉后又前进了 ${ahead} 个提交，未自动 rebase`)
    if (target) lines.push('', '## 与合并目标的冲突', '', await conflicts(origin(target)))
    return lines.join('\n')
  })

  await write('pr.md', async () => {
    const fields = 'number,url,title,body,isDraft'
    let pr: Type.Static<typeof prSchema> | undefined
    if (prUrl) {
      const value: unknown = JSON.parse(await gh('pr', 'view', prUrl, '--json', fields))
      if (!Value.Check(prSchema, value)) throw new Error('PR 格式无效')
      pr = value
    } else {
      const listed: unknown = JSON.parse(
        await gh(
          'pr',
          'list',
          '-R',
          repo.path,
          '--head',
          checkout.branch,
          '--state',
          'open',
          '--json',
          fields,
        ),
      )
      if (!Value.Check(Type.Array(prSchema), listed)) throw new Error('PR 列表格式无效')
      pr = listed[0]
    }
    if (!pr) return '无 open PR。'
    const intro = [
      `# ${pr.title}`,
      `- 链接：${pr.url}`,
      `- 是否草稿：${pr.isDraft ? '是' : '否'}`,
      '',
      pr.body,
    ]
    try {
      const detail: unknown = JSON.parse(
        await gh(
          'pr',
          'view',
          String(pr.number),
          '-R',
          repo.path,
          '--json',
          'reviews,comments,statusCheckRollup',
        ),
      )
      if (!Value.Check(prDetailSchema, detail)) throw new Error('PR 详情格式无效')
      const pages: unknown = JSON.parse(
        await gh('api', `repos/${repo.path}/pulls/${pr.number}/comments`, '--paginate', '--slurp'),
      )
      if (!Value.Check(inlinePagesSchema, pages)) throw new Error('PR 行内评论格式无效')
      return [
        ...intro,
        '',
        '## Review',
        ...detail.reviews.map(
          (review) =>
            `\n- ${review.author.login} · ${review.state} · ${review.submittedAt}\n\n${review.body}`,
        ),
        '',
        '## 评论',
        ...detail.comments.map(
          (comment) => `\n- ${comment.author.login} · ${comment.createdAt}\n\n${comment.body}`,
        ),
        '',
        '## 行内评论',
        ...pages
          .flat()
          .map(
            (comment) =>
              `\n- ${comment.path}:${comment.line ?? comment.original_line ?? '未知'} · ${comment.user.login} · ${comment.created_at}\n\n${comment.body}`,
          ),
        '',
        '## 检查',
        ...detail.statusCheckRollup.map(
          (check) =>
            `- ${check.name || check.context || '未知'}：${check.conclusion || check.state || '未知'}`,
        ),
      ].join('\n')
    } catch (error) {
      if (!prUrl) throw error
      warn('PR 反馈', error)
      return intro.join('\n')
    }
  })

  await write('docs.md', async () => {
    if (!checkout.docBranch) return '无文档分支。'
    const base = await readDefaultBranch({ repo, command })
    const paths = await git(
      'diff',
      '--name-only',
      `${origin(base)}...${origin(checkout.docBranch)}`,
    )
    return [
      `文档分支：${checkout.docBranch}`,
      ...paths
        .split('\n')
        .filter(Boolean)
        .map((path) => `- ${path}`),
    ].join('\n')
  })
}
