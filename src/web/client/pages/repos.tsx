import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { labels } from '../../issue-view.ts'
import { formatTime } from '../../views/format.ts'
import { issueListOptions } from '../issue-list.ts'
import { shellKey, usePageLayout } from '../layout.tsx'
import { repoRequest, reposOptions } from '../repos.ts'

type Repo = Awaited<ReturnType<typeof reposOptions.queryFn>>[number]

export function ReposPage() {
  const repos = useQuery(reposOptions)
  const issues = useQuery(issueListOptions)
  const queryClient = useQueryClient()
  const { setActive } = usePageLayout()
  const location = useLocation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [notice, setNotice] = useState('')
  const [addError, setAddError] = useState('')
  useEffect(() => {
    document.title = '仓库 · Workling'
    setActive('repos')
  }, [setActive])
  const ready = Boolean(repos.data && issues.data)
  useEffect(() => {
    if (location.hash === '#add' && dialog.current && !dialog.current.open)
      dialog.current.showModal()
  }, [location.key, location.hash, ready])
  const invalidate = async (message: string) => {
    await Promise.all(
      [['repos'], ['issue-list'], ['overview'], shellKey].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
    setNotice(message)
  }
  const add = useMutation({
    mutationFn: (body: { ref: string; token: string; enabled: boolean }) =>
      repoRequest('/api/repos', 'POST', body),
    onSuccess: async () => {
      dialog.current?.close()
      await invalidate('已添加仓库')
    },
    onError: (error) => setAddError(error.message),
  })
  function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    setAddError('')
    add.mutate(
      {
        ref: String(values.get('ref')),
        token: String(values.get('token')),
        enabled: values.has('enabled'),
      },
      { onSuccess: () => form.reset() },
    )
  }
  if ((!repos.data && repos.isPending) || (!issues.data && issues.isPending))
    return <p className="muted">加载中…</p>
  if (!repos.data || !issues.data || repos.isError || issues.isError)
    return (
      <p className="error-box" role="alert">
        加载页面失败{' '}
        <button
          className="button"
          type="button"
          onClick={() => {
            void repos.refetch()
            void issues.refetch()
          }}
        >
          重试
        </button>
      </p>
    )
  const data = issues.data
  return (
    <>
      <header className="page-head">
        <div>
          <h1>仓库</h1>
          <p>
            {repos.data.length} 个仓库 · watch 只轮询已启用仓库中带 workling:ready 的 open Issue
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => dialog.current?.showModal()}
        >
          添加仓库
        </button>
      </header>
      {notice && (
        <div className="notice">
          {notice}{' '}
          <button type="button" onClick={() => setNotice('')}>
            关闭
          </button>
        </div>
      )}
      {repos.data.length ? (
        <div className="repo-cards">
          {repos.data.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              issues={data.issues}
              now={data.now}
              invalidate={invalidate}
            />
          ))}
        </div>
      ) : (
        <section className="card">
          <h2>添加第一个仓库</h2>
          <p>
            workling 会轮询带 <code>workling:ready</code> 标签的 open Issue，并在本机执行任务。
          </p>
          <ol className="steps">
            <li>
              <strong>01　准备 token</strong>
              <p>
                GitHub fine-grained token，授予目标仓库 Contents、Pull requests、Issues 读写权限。
              </p>
            </li>
            <li>
              <strong>02　添加仓库</strong>
              <p>保存后 token 只显示末 4 位，可随时更换或停用。</p>
            </li>
            <li>
              <strong>03　给 Issue 打标签</strong>
              <p>打上 workling:ready，下一轮轮询即入队执行。</p>
            </li>
          </ol>
        </section>
      )}
      <dialog id="add-dialog" className="drawer" ref={dialog}>
        <div className="drawer-head">
          <h2>添加仓库</h2>
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            关闭
          </button>
        </div>
        <form id="add-form" onSubmit={submitAdd}>
          <div className="drawer-body">
            <div id="add-error" className="error-box" role="alert" hidden={!addError}>
              {addError}
            </div>
            <label className="field">
              仓库引用
              <input name="ref" required placeholder="github:owner/repo" />
              <small>格式 github:owner/repo</small>
            </label>
            <label className="field">
              Token
              <input name="token" type="password" required autoComplete="off" />
              <small>保存后只显示末 4 位，可随时更换</small>
            </label>
            <div className="perm">
              <strong>Token 所需权限</strong>
              <p>Contents 读写 — push 分支</p>
              <p>Pull requests 读写 — 创建 PR</p>
              <p>Issues 读写 — 改标签、评论</p>
            </div>
            <label className="checkbox">
              <input name="enabled" type="checkbox" defaultChecked /> 添加后立即启用
            </label>
          </div>
          <div className="drawer-foot">
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={add.isPending}>
              添加仓库
            </button>
          </div>
        </form>
      </dialog>
      <p className="muted">暂只支持 GitHub；GitLab 后续接入。</p>
    </>
  )
}

function RepoCard({
  repo,
  issues,
  now,
  invalidate,
}: {
  repo: Repo
  issues: Awaited<ReturnType<typeof issueListOptions.queryFn>>['issues']
  now: number
  invalidate: (message: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const toggle = useMutation({
    mutationFn: () => repoRequest(`/api/repos/${repo.id}`, 'PATCH', { enabled: !repo.enabled }),
    onSuccess: () => invalidate(repo.enabled ? '已停用' : '已启用'),
    onError: (e) => alert(e.message),
  })
  const remove = useMutation({
    mutationFn: () => repoRequest(`/api/repos/${repo.id}`, 'DELETE'),
    onSuccess: () => invalidate('已删除仓库'),
    onError: (e) => alert(e.message),
  })
  const changeToken = useMutation({
    mutationFn: () => repoRequest(`/api/repos/${repo.id}`, 'PATCH', { token }),
    onSuccess: async () => {
      setOpen(false)
      setToken('')
      setError('')
      await invalidate('已更换 token')
    },
    onError: (e) => setError(e.message),
  })
  return (
    <article className={`card repo${repo.enabled ? '' : ' off'}`}>
      <div className="repo-top">
        <div>
          <Link className="repo-name mono" to={`/repos/${repo.id}`}>
            {repo.ref}
          </Link>
          <p className="muted small">
            {repo.host} · token {repo.token}
            {!repo.enabled && ' · 已停用'}
          </p>
        </div>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-label={`启用 ${repo.ref}`}
          aria-checked={repo.enabled}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          <span></span>
        </button>
      </div>
      <div className="counts">
        {(['running', 'queued', 'failed', 'done'] as const).map((status) => (
          <div key={status}>
            <small>{labels[status]}</small>
            <b>{issues.filter((i) => i.repoId === repo.id && i.status === status).length}</b>
          </div>
        ))}
      </div>
      <div className="repo-foot">
        <span>更新于 {formatTime(repo.updatedAt, now)}</span>
        <div className="actions">
          <button type="button" className="link-button" onClick={() => setOpen(!open)}>
            更换 token
          </button>
          <button
            type="button"
            className="link-button danger"
            onClick={() => {
              if (prompt(`输入 ${repo.ref} 确认删除；该仓库的 Issue 记录会一并删除`) === repo.ref)
                remove.mutate()
            }}
          >
            删除
          </button>
        </div>
      </div>
      <form
        className="token-form row"
        hidden={!open}
        id={`token-form-${repo.id}`}
        onSubmit={(event) => {
          event.preventDefault()
          setError('')
          changeToken.mutate()
        }}
      >
        <input
          name="token"
          type="password"
          required
          placeholder="新 token"
          aria-label="新 token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="button button--primary" disabled={changeToken.isPending}>
          保存
        </button>
        <button className="button" type="button" onClick={() => setOpen(false)}>
          取消
        </button>
        <span className="error-text" role="alert">
          {error}
        </span>
      </form>
    </article>
  )
}
