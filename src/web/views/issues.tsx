import type { PageData } from '../data.ts'
import {
  IssueTable,
  StatusChips,
  selectedStatus,
  statusCounts,
  queuePositions,
  sortIssues,
} from './shared.tsx'

export function IssuesPage({
  data,
  filter,
  repo,
  q,
}: {
  data: PageData
  filter: string
  repo: string
  q: string
}) {
  const selected = selectedStatus(filter)
  const repoId = data.repos.find((r) => String(r.id) === repo)?.id
  const numberQuery = q.startsWith('#') || /^\d+$/.test(q)
  const items = data.issues.filter(
    (i) =>
      (!repoId || i.repoId === repoId) &&
      (!q ||
        (numberQuery
          ? /^#?\d+$/.test(q) && i.number === Number(q.replace(/^#/, ''))
          : (i.title ?? '').toLowerCase().includes(q.toLowerCase()))),
  )
  const params = new URLSearchParams({
    ...(repoId ? { repo: String(repoId) } : {}),
    ...(q ? { q } : {}),
  })
  return (
    <>
      <header class="page-head">
        <div>
          <h1>任务</h1>
          <p>workling 接手过的全部 Issue，状态由 watch 同步</p>
        </div>
      </header>
      <section class="card">
        <div class="toolbar">
          <StatusChips
            base={`/issues?${params}`}
            selected={selected}
            counts={statusCounts(items)}
          />
          <form method="get" action="/issues" class="actions" id="issue-filter">
            <select name="repo" aria-label="仓库">
              <option value="">全部仓库</option>
              {data.repos.map((r) => (
                <option value={r.id} selected={r.id === repoId}>
                  {r.ref}
                </option>
              ))}
            </select>
            <input
              name="q"
              type="search"
              value={q}
              placeholder="搜索标题或 #编号"
              aria-label="搜索标题或编号"
            />
            <input name="status" type="hidden" value={selected} />
            <button class="button">筛选</button>
          </form>
        </div>
        <IssueTable
          items={sortIssues(items.filter((i) => selected === 'all' || i.status === selected))}
          now={data.now}
          emptyText="没有符合条件的 Issue"
          queuePosition={queuePositions(data.issues)}
        />
      </section>
    </>
  )
}
