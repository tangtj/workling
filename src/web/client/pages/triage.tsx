import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Value from 'typebox/value'
import { triageOverviewSchema, type TriageData } from '../../triage-schema.ts'
import { repoRequest } from '../repos.ts'
import { settingsOptions } from '../settings.ts'
import { usePageLayout } from '../layout.tsx'
import { relativeTime } from '../../format.ts'
import { IssueRef } from '../issue-table.tsx'

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
    <div className="level-control">
      <div role="group" aria-label={`${refName} 分诊级别`} className="segmented">
        {levels.map(([value, label]) => (
          <button
            type="button"
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
  const percent = (part: number, total: number) =>
    total ? `${Math.round((part * 100) / total)}%` : '—'
  const filters = [
    ['all', '全部', records.length],
    ['mismatch', '只看不一致', records.filter(mismatch).length],
    ['pending', '等作者补充', records.filter((r) => r.followUp === 'pending').length],
  ] as const
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
        <p className="notice">
          LLM 未配置，请前往<Link to="/settings">设置页</Link>配置接入地址与 Key。
        </p>
      )}
      <section className="card">
        <header className="card-head">
          <h2>各仓库级别</h2>
          <span className="muted">
            关闭 → 影子（只记录）→ 建议（评论缺什么）→ 自动（直接打 ready）
          </span>
        </header>
        <div className="table-wrap">
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
                    <Link className="mono repo-link" to={`/repos/${repo.id}`}>
                      {repo.path}
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
                  <td className="num strong">{rate(repo.summary)}</td>
                  <td className="num">{repo.summary.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="triage-grid">
        <section className="card">
          <header className="card-head">
            <h2>机器结论 × 人工动作</h2>
            <span className="muted">{summary.total} 条样本</span>
          </header>
          <div className="card-body">
            <div className="matrix" role="table" aria-label="机器结论与人工动作对照">
              <div role="row" className="matrix-row matrix-head">
                <span role="columnheader"></span>
                <span role="columnheader">人工打了 ready</span>
                <span role="columnheader">人工没打 ready</span>
              </div>
              {(
                [
                  [
                    '机器 accept',
                    [summary.acceptReady, '一致', true],
                    [summary.acceptNotReady, '机器放宽了', false],
                  ],
                  [
                    '机器其他',
                    [summary.otherReady, '机器卡严了', false],
                    [summary.otherNotReady, '一致', true],
                  ],
                ] as const
              ).map(([label, ...cells]) => (
                <div role="row" className="matrix-row" key={label}>
                  <span role="rowheader">{label}</span>
                  {cells.map(([value, text, agree]) => (
                    <div
                      role="cell"
                      key={text + String(agree)}
                      className={`matrix-cell ${agree ? 'matrix-cell--agree' : 'matrix-cell--disagree'}`}
                    >
                      <strong>{value}</strong>
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="card-note">
              一致率 = 对角线 {summary.acceptReady + summary.otherNotReady} / {summary.total} ={' '}
              {rate(summary)}
            </p>
          </div>
        </section>
        <section className="card">
          <header className="card-head">
            <h2>建议的效果</h2>
            <span className="muted">建议级仓库</span>
          </header>
          <div className="card-body">
            <div className="stat-row">
              <div>
                <span>已评论建议</span>
                <strong>{suggestions.total}</strong>
              </div>
              <div>
                <span>作者补充了</span>
                <strong className="text-done">{suggestions.edited}</strong>
              </div>
              <div>
                <span>未改直接 ready</span>
                <strong className="text-failed">{suggestions.readyWithoutEdit}</strong>
              </div>
            </div>
            <p className="card-note">
              被跳过的比例 {percent(suggestions.readyWithoutEdit, suggestions.total)}，
              {suggestions.pending} 条仍在等作者
            </p>
          </div>
        </section>
      </div>
      <section className="card">
        <header className="card-head card-head--wrap">
          <h2>分诊记录</h2>
          <div className="head-tools">
            <div className="chips" role="group" aria-label="分诊记录筛选">
              {filters.map(([value, label, count]) => (
                <button
                  type="button"
                  className="chip"
                  aria-pressed={filter === value}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {label} <span>{count}</span>
                </button>
              ))}
            </div>
            <select
              aria-label="仓库"
              value={params.get('repo') ?? ''}
              onChange={(e) => {
                const next = new URLSearchParams(params)
                if (e.target.value) next.set('repo', e.target.value)
                else next.delete('repo')
                setParams(next)
              }}
            >
              <option value="">全部仓库</option>
              {data.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.ref}
                </option>
              ))}
            </select>
          </div>
        </header>
        {visible.length === 0 ? (
          <p className="empty">暂无分诊记录</p>
        ) : (
          <div className="table-wrap">
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
                  <th>
                    <span className="sr-only">说明</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const repo = data.repos.find((r) => r.id === row.repoId)
                  return (
                    <Fragment key={row.id}>
                      <tr className={mismatch(row) ? 'row-disagree' : ''}>
                        <td>
                          <div className="issue-cell">
                            <IssueRef repoRef={row.repoRef} number={row.number} />
                            <a
                              className="issue-title"
                              href={`https://${repo?.host}/${repo?.path}/issues/${row.number}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {row.title}
                            </a>
                          </div>
                        </td>
                        <td className="nowrap">
                          {row.authorLogin}{' '}
                          <small>· {row.trust === 'write' ? '写权限' : '受信账号'}</small>
                        </td>
                        <td>
                          {row.decision ? (
                            <span
                              className={`badge badge--plain ${row.decision === 'accept' ? 'badge--done' : row.decision === 'ignore' ? 'badge--queued' : 'badge--info'}`}
                            >
                              {row.decision}
                            </span>
                          ) : (
                            <span className="muted">无结论</span>
                          )}
                          {row.llmDecision && row.llmDecision !== row.decision && (
                            <div className="cell-sub">LLM：{row.llmDecision}</div>
                          )}
                          {!row.decision && row.error && (
                            <div className="cell-sub">{row.error}</div>
                          )}
                        </td>
                        <td>{row.missing.join('、') || '—'}</td>
                        <td className="nowrap">
                          {row.autoQueuedAt
                            ? '自动 ready'
                            : row.readyAt
                              ? `ready${row.readyAfterMinutes === null ? '' : ` · ${row.readyAfterMinutes} 分钟`}`
                              : '未 ready'}
                        </td>
                        <td className="nowrap">
                          {row.suggestCommentUrl && (
                            <>
                              <a href={row.suggestCommentUrl} target="_blank" rel="noreferrer">
                                已评论
                              </a>{' '}
                            </>
                          )}
                          <small>
                            {row.followUp === 'edited'
                              ? '· 已补充'
                              : row.followUp === 'readyWithoutEdit'
                                ? '· 未改直接 ready'
                                : row.followUp === 'pending'
                                  ? '· 等作者'
                                  : row.suggestCommentUrl
                                    ? ''
                                    : '—'}
                          </small>
                        </td>
                        <td
                          className="nowrap muted"
                          title={new Date(row.triagedAt).toLocaleString()}
                        >
                          {relativeTime(new Date(row.triagedAt), Date.now())}
                        </td>
                        <td>
                          {(row.note || row.error || row.suggestError) && (
                            <button
                              type="button"
                              className="button button--sm"
                              aria-expanded={expanded.includes(row.id)}
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
                        <tr className="row-details">
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
