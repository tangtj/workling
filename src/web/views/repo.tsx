import type { PageData } from '../data.ts'
import { maskToken } from '../data.ts'
import {
  IssueTable,
  StatusChips,
  selectedStatus,
  statusCounts,
  queuePositions,
  sortIssues,
} from './shared.tsx'

export function RepoPage({ data, id, filter }: { data: PageData; id: number; filter: string }) {
  const repo = data.repos.find((r) => r.id === id)!
  const items = data.issues.filter((i) => i.repoId === id)
  const selected = selectedStatus(filter)
  return (
    <>
      <nav class="breadcrumbs">
        <a href="/repos">仓库</a> / {repo.ref}
      </nav>
      <header class="page-head">
        <div>
          <h1 class="mono">{repo.ref}</h1>
          <p>
            {repo.enabled ? '已启用' : '已停用'} · Token {maskToken(repo.token)} ·{' '}
            <a href={`https://${repo.host}/${repo.path}/issues`} rel="noreferrer">
              GitHub Issues ↗
            </a>
          </p>
        </div>
      </header>
      <section class="card">
        <div class="toolbar">
          <StatusChips base={`/repos/${id}`} selected={selected} counts={statusCounts(items)} />
        </div>
        <IssueTable
          items={sortIssues(items.filter((i) => selected === 'all' || i.status === selected))}
          now={data.now}
          emptyText="没有符合条件的 Issue"
          queuePosition={queuePositions(data.issues)}
        />
      </section>
      <p class="muted">Issue 状态由 watch 轮询并同步；在 GitHub 重新打上 workling:ready 可重试。</p>
    </>
  )
}
