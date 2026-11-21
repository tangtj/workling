import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  stageFromParams,
  stageCounts,
  queuePositions,
  sortIssues,
  matchesStage,
} from '../../issue-view.ts'
import { platformName } from '../../platform.ts'
import { issueListOptions } from '../issue-list.ts'
import { IssueTable, PlatformIcon, StatusChips } from '../issue-table.tsx'
import { usePageLayout } from '../layout.tsx'
import { loadTrustedUsers } from '../feedback.ts'
import { repoRequest } from '../repos.ts'
import { LevelButtons, rate } from './triage.tsx'
import * as Value from 'typebox/value'
import { triageSchema } from '../../triage-schema.ts'
import { NotFound } from '../not-found.tsx'

function TrustedUsers({ id, github }: { id: number; github: boolean }) {
  const [user, setUser] = useState('')
  const client = useQueryClient()
  const key = ['trusted-users', id]
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => loadTrustedUsers(id, signal) })
  const mutation = useMutation({
    mutationFn: ({ value, remove }: { value: string; remove?: boolean }) =>
      repoRequest(
        `/api/repos/${id}/trusted-users${remove ? `/${encodeURIComponent(value)}` : ''}`,
        remove ? 'DELETE' : 'POST',
        remove ? undefined : { user: value },
      ),
    onSuccess: () => {
      setUser('')
      void client.invalidateQueries({ queryKey: key })
    },
  })
  return (
    <section className="card">
      <h2>受信账号</h2>
      <p>
        对仓库有写权限的成员默认可信，这里额外放行没有写权限的账号；bot 与 workling
        自身评论永远不算指令。
      </p>
      {!github && <p>暂只支持 GitHub</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate({ value: user })
        }}
      >
        <input
          aria-label="用户名或主页链接"
          value={user}
          onChange={(event) => setUser(event.target.value)}
          disabled={!github || mutation.isPending}
          placeholder="用户名或主页链接"
        />{' '}
        <button className="button" disabled={!github || !user.trim() || mutation.isPending}>
          添加
        </button>
      </form>
      {mutation.error && (
        <p className="error-box" role="alert">
          {mutation.error.message}
        </p>
      )}
      {list.isError && <p className="error-box">加载受信账号失败</p>}
      {list.data?.map((entry) => (
        <div className="row" key={entry.id}>
          <span>
            {entry.login} · ID {entry.userId}
          </span>
          <button
            className="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ value: entry.userId, remove: true })}
          >
            移除
          </button>
        </div>
      ))}
    </section>
  )
}

function Triage({ id, refName, github }: { id: number; refName: string; github: boolean }) {
  const query = useQuery({
    queryKey: ['triage', id],
    queryFn: async () => {
      const body: unknown = await repoRequest(`/api/repos/${id}/triage`, 'GET')
      if (!Value.Check(triageSchema, body)) throw new Error('分诊数据无效')
      return body
    },
  })
  return (
    <section className="card">
      <h2>分诊</h2>
      {query.data && (
        <>
          <LevelButtons id={id} refName={refName} level={query.data.level} github={github} />
          <p>
            一致率 {rate(query.data.summary)} · 样本 {query.data.summary.total}
          </p>
          <Link to={`/triage?repo=${id}`}>查看分诊记录</Link>
        </>
      )}
      {query.error && <p className="error-box">{query.error.message}</p>}
    </section>
  )
}

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
  const selected = stageFromParams(params)
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
      <Triage id={repo.id} refName={repo.ref} github={repo.platform === 'github'} />
      <TrustedUsers id={repo.id} github={repo.platform === 'github'} />
      <section className="card">
        <div className="toolbar">
          <StatusChips selected={selected} counts={stageCounts(items)} />
        </div>
        <IssueTable
          items={sortIssues(items.filter((i) => matchesStage(i.stage, selected)))}
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
