import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { type WorklingDatabase } from '../db/index.ts'
import { issues as issueStates, repos } from '../db/schema.ts'
import { readSubIssues } from '../issue/chain.ts'
import { ghEnv } from '../platform/github.ts'
import type { Command } from '../runtime/types.ts'
import { setStatusLabel } from './status-label.ts'
const issuesSchema = Type.Array(
  Type.Object({ number: Type.Integer(), title: Type.String(), url: Type.String() }),
)

type Log = (message: string) => void

export const WORKLING_LABELS = [
  { name: 'workling:needs-info', color: 'FBCA04', description: '信息不全，补充正文后会重新分诊' },
  { name: 'workling:hold', color: 'BFD4F2', description: '暂不自动执行，由人决定何时打 ready' },
  { name: 'workling:ready', color: '0E8A16', description: '等待 workling 领取' },
  { name: 'workling:queued', color: 'C5DEF5', description: 'workling 已入队' },
  { name: 'workling:running', color: '1D76DB', description: 'workling 执行中' },
  { name: 'workling:done', color: '5319E7', description: 'workling 已完成' },
  { name: 'workling:failed', color: 'D93F0B', description: 'workling 执行失败' },
] as const

export async function ensureLabels({
  repo,
  command,
  signal,
}: {
  repo: typeof repos.$inferSelect
  command: Command
  signal: AbortSignal
}) {
  const env = ghEnv(repo.token, repo.host)
  for (const label of WORKLING_LABELS) {
    await command(
      [
        'gh',
        'label',
        'create',
        label.name,
        '-R',
        repo.path,
        '--color',
        label.color,
        '--description',
        label.description,
        '--force',
      ],
      { env, signal },
    )
  }
}

export async function pollOnce({
  db,
  command,
  signal,
  log,
  labeledRepos,
}: {
  db: WorklingDatabase
  command: Command
  signal: AbortSignal
  log: Log
  labeledRepos?: Set<number>
}) {
  let expanded = 0
  const rows = db.select().from(repos).where(eq(repos.enabled, true)).orderBy(repos.id).all()
  for (const row of rows) {
    if (signal.aborted) break
    if (row.platform !== 'github') continue
    let labelsReady = labeledRepos?.has(row.id) ?? false
    if (!labelsReady) {
      try {
        await ensureLabels({ repo: row, command, signal })
        if (signal.aborted) break
        labeledRepos?.add(row.id)
        labelsReady = true
      } catch (error) {
        if (signal.aborted) break
        log(`${row.ref} 创建标签失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const output = await command(
        [
          'gh',
          'issue',
          'list',
          '-R',
          row.path,
          '--label',
          'workling:ready',
          '--state',
          'open',
          '--limit',
          '100',
          '--json',
          'number,title,url',
        ],
        {
          env: ghEnv(row.token, row.host),
          signal,
        },
      )
      if (signal.aborted) break
      const issues: unknown = JSON.parse(output)
      if (!Value.Check(issuesSchema, issues)) throw new Error('Issue 列表格式无效')
      issues.sort((a, b) => a.number - b.number)
      if (issues.length === 0) log(`${row.ref} 无 workling:ready Issue`)
      for (const issue of issues) {
        if (signal.aborted) break
        log(`${row.ref} #${issue.number} ${issue.title} ${issue.url}`)
        let subs
        try {
          subs = await readSubIssues({ repo: row, number: issue.number, command, signal })
          if (subs.length) {
            for (const sub of subs) {
              if (!sub.sameRepo || sub.state !== 'open') continue
              const existingSub = db
                .select()
                .from(issueStates)
                .where(and(eq(issueStates.repoId, row.id), eq(issueStates.number, sub.number)))
                .get()
              if (existingSub && !['failed', 'canceled'].includes(existingSub.status)) continue
              await command(
                [
                  'gh',
                  'issue',
                  'edit',
                  String(sub.number),
                  '-R',
                  row.path,
                  '--add-label',
                  'workling:ready',
                ],
                { env: ghEnv(row.token, row.host), signal },
              )
            }
            await command(
              [
                'gh',
                'issue',
                'edit',
                String(issue.number),
                '-R',
                row.path,
                '--remove-label',
                'workling:ready',
                '--add-label',
                'workling:running',
              ],
              { env: ghEnv(row.token, row.host), signal },
            )
            expanded++
            log(
              `${row.ref} #${issue.number} 主 Issue：展开 ${subs.length} 个子 Issue（${subs.map((sub) => `#${sub.number}`).join(' ')}）`,
            )
            continue
          }
        } catch (error) {
          log(
            `${row.ref} #${issue.number} 展开子 Issue 失败：${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        const existing = db
          .select()
          .from(issueStates)
          .where(and(eq(issueStates.repoId, row.id), eq(issueStates.number, issue.number)))
          .get()
        const now = new Date()
        if (!existing) {
          db.insert(issueStates)
            .values({
              repoId: row.id,
              number: issue.number,
              title: issue.title,
              status: 'queued',
              createdAt: now,
              updatedAt: now,
            })
            .run()
          log(`${row.ref} #${issue.number} 已入队`)
        } else if (['done', 'failed', 'canceled'].includes(existing.status)) {
          db.update(issueStates)
            .set({ status: 'queued', updatedAt: now, title: issue.title })
            .where(eq(issueStates.id, existing.id))
            .run()
          log(`${row.ref} #${issue.number} 重新入队`)
        } else if (existing.title !== issue.title) {
          db.update(issueStates)
            .set({ title: issue.title })
            .where(eq(issueStates.id, existing.id))
            .run()
        }
        if (existing?.status === 'running') {
          log(`${row.ref} #${issue.number} 执行中但仍带 workling:ready，已忽略`)
        } else if (labelsReady) {
          try {
            await setStatusLabel({
              repo: row,
              number: issue.number,
              target: 'queued',
              command,
              signal,
              removeReady: true,
            })
            log(`${row.ref} #${issue.number} 已标记 workling:queued`)
          } catch (error) {
            if (signal.aborted) break
            // 库是事实来源；标签同步失败时，下轮仍会列出该 Issue 并重试。
            log(
              `${row.ref} #${issue.number} 更新标签失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
    } catch (error) {
      if (signal.aborted) break
      log(`${row.ref} 轮询失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { expanded }
}
