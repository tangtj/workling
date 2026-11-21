import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  filterIssues,
  stageFromParams,
  stageCounts,
  queuePositions,
  sortIssues,
  matchesStage,
} from '../../issue-view.ts'
import { issueListOptions } from '../issue-list.ts'
import { IssueTable, StatusChips } from '../issue-table.tsx'
import { usePageLayout } from '../layout.tsx'

export function IssuesPage() {
  const page = useQuery(issueListOptions)
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { setActive } = usePageLayout()
  const q = (params.get('q') ?? '').trim()
  const [search, setSearch] = useState(q)
  useEffect(() => setSearch(q), [q])
  useEffect(() => {
    document.title = '任务 · Workling'
    setActive('issues')
  }, [setActive])
  if (!page.data && page.isPending) return <p className="muted">加载中…</p>
  if (!page.data)
    return (
      <p className="error-box" role="alert">
        加载页面失败{' '}
        <button className="button" type="button" onClick={() => void page.refetch()}>
          重试
        </button>
      </p>
    )
  const data = page.data
  const selected = stageFromParams(params)
  const repoId = data.repos.find((r) => String(r.id) === params.get('repo'))?.id
  const items = filterIssues(data.issues, repoId, q)
  const submit = (repo: string, query: string) => {
    const next = new URLSearchParams(params)
    next.set('repo', repo)
    next.set('q', query)
    next.delete('status')
    next.set('stage', selected)
    void navigate(`/issues?${next}`)
  }
  return (
    <>
      <header className="page-head">
        <div>
          <h1>任务</h1>
          <p>workling 接手过的全部 Issue，按阶段归类；状态由 watch 同步</p>
        </div>
      </header>
      <section className="card">
        <div className="toolbar toolbar--stack">
          <StatusChips selected={selected} counts={stageCounts(items)} />
          <form
            method="get"
            action="/issues"
            className="filter-row"
            id="issue-filter"
            onSubmit={(e) => {
              e.preventDefault()
              submit(String(repoId ?? ''), search)
            }}
          >
            <select
              name="repo"
              aria-label="仓库"
              value={repoId ?? ''}
              onChange={(e) => submit(e.target.value, search)}
            >
              <option value="">全部仓库</option>
              {data.repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.ref}
                </option>
              ))}
            </select>
            <input
              name="q"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题或 #编号"
              aria-label="搜索标题或编号"
            />
            <input name="stage" type="hidden" value={selected} />
          </form>
        </div>
        <IssueTable
          items={sortIssues(items.filter((i) => matchesStage(i.stage, selected)))}
          repos={data.repos}
          now={data.now}
          queuePosition={queuePositions(data.issues)}
        />
      </section>
      <p className="page-note">
        失败或 PR 仍开着时，在 Issue 或 PR 评论 <code>/workling 补充说明</code> 或{' '}
        <code>@workling-agent</code>，就会在同一分支上接着做；只有受信账号的评论算指令。
      </p>
    </>
  )
}
