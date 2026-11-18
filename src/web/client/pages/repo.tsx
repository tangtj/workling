import { useEffect } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { selectedStatus, statusCounts, queuePositions, sortIssues } from '../../issue-view.ts'
import { platformName } from '../../platform.ts'
import { issueListOptions } from '../issue-list.ts'
import { IssueTable, PlatformIcon, StatusChips } from '../issue-table.tsx'
import { usePageLayout } from '../layout.tsx'
import { NotFound } from '../legacy-page.tsx'

export function RepoPage() {
  const page = useQuery(issueListOptions)
  const { id } = useParams()
  const [params] = useSearchParams()
  const { setActive } = usePageLayout()
  const repo = page.data?.repos.find((r) => String(r.id) === id)
  useEffect(() => {
    if (repo) {
      document.title = '仓库详情 · Workling'
      setActive('repos')
    }
  }, [repo, setActive])
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
  if (!repo) return <NotFound />
  const data = page.data
  const items = data.issues.filter((i) => i.repoId === repo.id)
  const selected = selectedStatus(params.get('status') ?? 'all')
  return (
    <>
      <nav className="breadcrumbs">
        <Link to="/repos">仓库</Link> / {repo.ref}
      </nav>
      <header className="page-head">
        <div>
          <h1 className="mono">{repo.ref}</h1>
          <p>
            {repo.enabled ? '已启用' : '已停用'} · Token {repo.tokenMask} ·{' '}
            <a
              href={`https://${repo.host}/${repo.path}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`在 ${platformName[repo.platform]} 查看 Issues`}
            >
              <PlatformIcon platform={repo.platform} /> Issues
            </a>
          </p>
        </div>
      </header>
      <section className="card">
        <div className="toolbar">
          <StatusChips selected={selected} counts={statusCounts(items)} />
        </div>
        <IssueTable
          items={sortIssues(items.filter((i) => selected === 'all' || i.status === selected))}
          repos={data.repos}
          now={data.now}
          queuePosition={queuePositions(data.issues)}
        />
      </section>
      <p className="muted">
        Issue 状态由 watch 轮询并同步；在 GitHub 重新打上 workling:ready 可重试。
      </p>
    </>
  )
}
