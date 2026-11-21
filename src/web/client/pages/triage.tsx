import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Value from 'typebox/value'
import { triageOverviewSchema, type TriageData } from '../../triage-schema.ts'
import { repoRequest } from '../repos.ts'
import { settingsOptions } from '../settings.ts'
import { usePageLayout } from '../layout.tsx'

export const triageOptions = {
  queryKey: ['triage-overview'],
  queryFn: async () => {
    const body: unknown = await repoRequest('/api/triage', 'GET')
    if (!Value.Check(triageOverviewSchema, body)) throw new Error('分诊数据无效')
    return body
  },
}
const levels = [
  ['off', '关闭'],
  ['shadow', '影子'],
  ['suggest', '建议'],
  ['auto', '自动'],
] as const
export function LevelButtons({
  id,
  refName,
  level,
  github,
}: {
  id: number
  refName: string
  level: TriageData['level']
  github: boolean
}) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (value: string) =>
      repoRequest(`/api/repos/${id}/triage-level`, 'PUT', { level: value }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['triage-overview'] })
      void client.invalidateQueries({ queryKey: ['triage', id] })
    },
  })
  const confirms: Record<string, string> = {
    suggest: '建议级会对受信作者信息不全的 Issue 打标签并评论。确认开启？',
    auto: '自动级除建议外，还会在受信作者的 Issue 判定为信息齐全后自动打 workling:ready 开始执行（带 workling:hold 的除外）。确认开启？',
  }
  return (
    <div>
      <div role="group" aria-label={`${refName} 分诊级别`} className="level-group">
        {levels.map(([value, label]) => (
          <button
            type="button"
            className={`button${level === value ? ' selected' : ''}`}
            aria-pressed={level === value}
            disabled={!github || mutation.isPending}
            key={value}
            onClick={() => {
              if (value === level) return
              if (!confirms[value] || window.confirm(confirms[value])) mutation.mutate(value)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {!github && <small>暂只支持 GitHub</small>}
      {mutation.error && <p className="error-box">{mutation.error.message}</p>}
    </div>
  )
}
export function rate(summary: TriageData['summary']) {
  return summary.total
    ? `${Math.round(((summary.acceptReady + summary.otherNotReady) * 100) / summary.total)}%`
    : '—'
}
function mismatch(row: TriageData['records'][number]) {
  return (
    !row.alreadyReady &&
    ((row.decision === 'accept' && !row.readyAt) ||
      ((row.decision === 'needs_info' || row.decision === 'ignore') && !!row.readyAt))
  )
}
function ago(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000))
  return minutes < 60
    ? `${minutes} 分钟前`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} 小时前`
      : `${Math.floor(minutes / 1440)} 天前`
}
export function TriagePage() {
  const { setActive } = usePageLayout()
  useEffect(() => {
    document.title = '分诊 · Workling'
    setActive('triage')
  }, [setActive])
  const query = useQuery(triageOptions)
  const settings = useQuery(settingsOptions)
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<'all' | 'mismatch' | 'pending'>('all')
  const [expanded, setExpanded] = useState<number[]>([])
  if (!query.data) return <p>{query.isError ? `加载失败：${query.error.message}` : '加载中…'}</p>
  const data = query.data,
    summary = data.summary,
    suggestions = summary.suggestions
  const records = data.records.filter(
    (row) => !params.get('repo') || String(row.repoId) === params.get('repo'),
  )
  const visible = records.filter(
    (row) =>
      filter === 'all' || (filter === 'mismatch' ? mismatch(row) : row.followUp === 'pending'),
  )
  return (
    <>
      <header className="page-head">
        <div>
          <h1>分诊</h1>
          <p>
            新 Issue 先由 LLM 判断能否开工；影子级只记录，与人工是否打 ready
            对照，数据靠得住再逐个仓库放开。
          </p>
        </div>
      </header>
      {settings.data && (!settings.data.pi.llmBaseUrl || !settings.data.pi.llmApiKey) && (
        <p>
          LLM 未配置，请前往<Link to="/settings">设置页</Link>配置接入地址与 Key。
        </p>
      )}
      <section className="card">
        <h2>各仓库级别</h2>
        <div className="triage-table">
          <table>
            <thead>
              <tr>
                <th>仓库</th>
                <th>级别</th>
                <th>一致率</th>
                <th>样本</th>
              </tr>
            </thead>
            <tbody>
              {data.repos.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <Link className="mono" to={`/repos/${repo.id}`}>
                      {repo.ref}
                    </Link>
                  </td>
                  <td>
                    <LevelButtons
                      id={repo.id}
                      refName={repo.ref}
                      level={repo.level}
                      github={repo.platform === 'github'}
                    />
                  </td>
                  <td>{rate(repo.summary)}</td>
                  <td>{repo.summary.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="triage-grid">
        <section className="card">
          <h2>机器结论 × 人工动作</h2>
          <div className="triage-table">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>人工打了 ready</th>
                  <th>人工没打 ready</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>机器 accept</th>
                  <td className="triage-agree">{summary.acceptReady} 一致</td>
                  <td className="triage-disagree">{summary.acceptNotReady} 机器放宽了</td>
                </tr>
                <tr>
                  <th>机器其他</th>
                  <td className="triage-disagree">{summary.otherReady} 机器卡严了</td>
                  <td className="triage-agree">{summary.otherNotReady} 一致</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            一致率 = {summary.acceptReady + summary.otherNotReady} / {summary.total} ={' '}
            {rate(summary)}
          </p>
        </section>
        <section className="card">
          <h2>建议的效果</h2>
          <p>
            已评论建议 {suggestions.total} · 作者补充了 {suggestions.edited} · 未改直接 ready{' '}
            {suggestions.readyWithoutEdit}
          </p>
          <p>
            被跳过的比例{' '}
            {suggestions.total
              ? `${Math.round((suggestions.readyWithoutEdit * 100) / suggestions.total)}%`
              : '—'}
            ，{suggestions.pending} 条仍在等作者
          </p>
        </section>
      </div>
      <section className="card">
        <h2>分诊记录</h2>
        <div className="toolbar">
          {(
            [
              ['all', '全部', records.length],
              ['mismatch', '只看不一致', records.filter(mismatch).length],
              ['pending', '等作者补充', records.filter((r) => r.followUp === 'pending').length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              className={`button${filter === value ? ' selected' : ''}`}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label} {count}
            </button>
          ))}
          <label>
            仓库{' '}
            <select
              value={params.get('repo') ?? ''}
              onChange={(e) => {
                const next = new URLSearchParams(params)
                if (e.target.value) next.set('repo', e.target.value)
                else next.delete('repo')
                setParams(next)
              }}
            >
              <option value="">全部</option>
              {data.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.ref}
                </option>
              ))}
            </select>
          </label>
        </div>
        {visible.length === 0 ? (
          <p>暂无分诊记录</p>
        ) : (
          <div className="triage-table">
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>作者</th>
                  <th>机器结论</th>
                  <th>缺少</th>
                  <th>人工</th>
                  <th>跟进</th>
                  <th>分诊时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const repo = data.repos.find((r) => r.id === row.repoId)
                  return (
                    <Fragment key={row.id}>
                      <tr className={mismatch(row) ? 'triage-disagree' : ''}>
                        <td>
                          <a
                            href={`https://${repo?.host}/${repo?.path}/issues/${row.number}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className="mono">
                              {row.repoRef}#{row.number}
                            </span>{' '}
                            {row.title}
                          </a>
                        </td>
                        <td>
                          {row.authorLogin}
                          <br />
                          <small>{row.trust === 'write' ? '写权限' : '受信账号'}</small>
                        </td>
                        <td>
                          <span
                            className={`badge ${row.decision === 'accept' ? 'badge--done' : row.decision === 'ignore' ? 'badge--queued' : 'triage-warn'}`}
                          >
                            {row.decision ?? '无结论'}
                          </span>
                          {row.llmDecision && row.llmDecision !== row.decision && (
                            <div>LLM：{row.llmDecision}</div>
                          )}
                          {!row.decision && row.error && <small>{row.error}</small>}
                        </td>
                        <td>{row.missing.join('、') || '—'}</td>
                        <td>
                          {row.autoQueuedAt
                            ? '自动 ready'
                            : row.readyAt
                              ? `ready${row.readyAfterMinutes === null ? '' : ` · ${row.readyAfterMinutes} 分钟`}`
                              : '未 ready'}
                        </td>
                        <td>
                          {row.suggestCommentUrl && (
                            <a href={row.suggestCommentUrl} target="_blank" rel="noreferrer">
                              已评论{' '}
                            </a>
                          )}
                          {row.followUp === 'edited'
                            ? '已补充'
                            : row.followUp === 'readyWithoutEdit'
                              ? '未改直接 ready'
                              : row.followUp === 'pending'
                                ? '等作者'
                                : '—'}
                        </td>
                        <td>{ago(row.triagedAt)}</td>
                        <td>
                          {(row.note || row.error || row.suggestError) && (
                            <button
                              className="button"
                              onClick={() =>
                                setExpanded(
                                  expanded.includes(row.id)
                                    ? expanded.filter((id) => id !== row.id)
                                    : [...expanded, row.id],
                                )
                              }
                            >
                              说明
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded.includes(row.id) && (
                        <tr key={`${row.id}-details`}>
                          <td colSpan={8}>
                            {[row.note, row.error, row.suggestError].filter(Boolean).join(' · ')}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
