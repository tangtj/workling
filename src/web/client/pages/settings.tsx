import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import type { SettingsData } from '../../settings.ts'
import { executorSettingsSchema, piSettingsSchema } from '../../settings.ts'
import * as Value from 'typebox/value'
import { shellKey, usePageLayout } from '../layout.tsx'
import { repoRequest } from '../repos.ts'
import { cardBody, cardDraft, isDirty, settingsOptions, syncDraft, type Card } from '../settings.ts'

const sections = [
  ['codex', 'Codex'],
  ['pi', 'Pi 与 LLM'],
  ['git', '提交身份'],
  ['executor', '执行器'],
  ['password', '管理密码'],
  ['env', '启动参数'],
  ['labels', '标签与命令'],
]
const descriptions: Record<Card, [string, string, string]> = {
  codex: ['Codex', '实现 Issue 时使用的默认模型与推理强度', '保存后下一轮轮询生效'],
  pi: ['Pi 与 LLM 接入', 'Pi 负责组装提示词、核对和交付 PR', '留空 Key 表示不修改'],
  git: ['提交身份', 'Pi 提交代码时的作者信息', 'PR 作者仍是仓库 token 对应的账号'],
  executor: [
    '执行器',
    '切换只影响之后拉起的任务；Docker 需本机已构建镜像且已配置 LLM 接入地址',
    '本机进程模式下容器参数不生效',
  ],
}

export function SettingsPage() {
  const query = useQuery(settingsOptions)
  const { setActive } = usePageLayout()
  const location = useLocation()
  const [notice, setNotice] = useState('')
  useEffect(() => {
    document.title = '设置 · Workling'
    setActive('settings')
  }, [setActive])
  const ready = Boolean(query.data)
  useEffect(() => {
    if (ready && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [ready, location.hash])
  if (!query.data)
    return query.isPending ? (
      <p className="muted">加载中…</p>
    ) : (
      <p className="error-box" role="alert">
        加载页面失败{' '}
        <button type="button" onClick={() => void query.refetch()}>
          重试
        </button>
      </p>
    )
  const data = query.data
  return (
    <>
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p>保存后下一轮轮询生效，运行中的任务不受影响</p>
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}{' '}
          <button type="button" onClick={() => setNotice('')}>
            关闭
          </button>
        </div>
      )}
      <div className="settings">
        <nav className="subnav" aria-label="设置分区">
          {sections.map(([id, title], index) => (
            <a key={id} className={index === 5 ? 'subnav-divider' : ''} href={`#set-${id}`}>
              {title}
            </a>
          ))}
        </nav>
        <div className="stack">
          {(['codex', 'pi', 'git', 'executor'] as const).map((card) => (
            <SettingsCard key={card} card={card} data={data} notice={setNotice} />
          ))}
          <PasswordCard notice={setNotice} />
          <section className="card" id="set-env">
            <div className="card-head">
              <div>
                <h2>启动参数</h2>
                <p className="muted small">只能在 .env 中修改，重启 serve 生效</p>
              </div>
              <span className="badge badge--canceled">只读</span>
            </div>
            {data.startup ? (
              <div className="kv">
                {[
                  ['WORKLING_WORKSPACE', data.startup.workspace, '工作区与数据库'],
                  ['WORKLING_WORKER', data.startup.worker, '写入评论与运行记录'],
                  [
                    'WORKLING_HOST / WORKLING_PORT',
                    `${data.startup.host}:${data.startup.port}`,
                    '管理页监听地址',
                  ],
                  [
                    'WORKLING_ALLOWED_HOSTS',
                    data.startup.allowedHosts.join(', ') || '未设置',
                    '额外放行的域名',
                  ],
                  ['WORKLING_SECURE_COOKIE', String(data.startup.secureCookie), 'HTTPS 部署时开启'],
                ].map(([key, value, description]) => (
                  <ReadRow key={key} label={key} value={value} description={description} />
                ))}
              </div>
            ) : (
              <p className="empty">未提供启动参数</p>
            )}
          </section>
          <section className="grid g-2" id="set-labels">
            <div className="card">
              <div className="card-head">
                <h2>状态标签</h2>
                <span className="small muted">只有 watch 改标签</span>
              </div>
              <div className="labels">
                {data.labels.map((label) => (
                  <div className="lbl" key={label.name}>
                    <span className={`gh-label gh-label--${label.name.slice(6)}`}>
                      {label.name}
                    </span>
                    <span>{label.description}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>运维命令</h2>
              </div>
              <div className="cmds">
                {[
                  ['启动服务', 'bun run start'],
                  ['取消任务', 'workling cancel github:owner/repo#12'],
                  ['重置密码', 'workling reset-password'],
                ].map(([label, command]) => (
                  <CopyCommand key={command} label={label} command={command} />
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
function ReadRow({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description: string
}) {
  return (
    <>
      <div className="k">{label}</div>
      <div className="mono small">{value}</div>
      <div className="d">{description}</div>
    </>
  )
}
function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div className="cmd">
      <span>{label}</span>
      <code>{command}</code>
      <button
        className="button button--sm"
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(command)
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}
function SettingsCard({
  card,
  data,
  notice,
}: {
  card: Card
  data: SettingsData
  notice: (s: string) => void
}) {
  const client = useQueryClient()
  const [baseline, setBaseline] = useState(() => cardDraft(data, card))
  const [draft, setDraft] = useState(() => cardDraft(data, card))
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const source = card === 'executor' ? data.executor : data.pi
  useEffect(() => {
    const next = cardDraft(data, card)
    setDraft((current) => syncDraft(baseline, current, next, false))
    setBaseline(next)
  }, [source, card])
  const dirty = isDirty(baseline, draft)
  const update = (field: string, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setSaved(false)
  }
  const input = (
    field: string,
    label: string,
    extra: {
      type?: string
      required?: boolean
      min?: string
      max?: string
      step?: string
      hint?: string
      span?: boolean
    } = {},
  ) => (
    <label className={`field${extra.span ? ' span-2' : ''}`}>
      {label}
      <input
        name={field}
        type={extra.type}
        required={extra.required}
        min={extra.min}
        max={extra.max}
        step={extra.step}
        value={draft[field]}
        onChange={(e) => update(field, e.target.value)}
      />
      {extra.hint && <small>{extra.hint}</small>}
    </label>
  )
  async function save(body: unknown, clear = false) {
    setError('')
    setPending(true)
    const submitted = draft
    try {
      const result: unknown = await repoRequest(
        `/api/settings/${card === 'executor' ? 'executor' : 'pi'}`,
        'PATCH',
        body,
      )
      if (
        card === 'executor'
          ? !Value.Check(executorSettingsSchema, result)
          : !Value.Check(piSettingsSchema, result)
      )
        throw new Error('设置数据无效')
      const nextData = {
        ...data,
        [card === 'executor' ? 'executor' : 'pi']: result,
      } as SettingsData
      const next = cardDraft(nextData, card)
      setBaseline(next)
      setDraft((current) =>
        clear
          ? syncDraft(baseline, current, next, false)
          : syncDraft(submitted, current, next, false),
      )
      client.setQueryData<SettingsData>(['settings'], (current) =>
        current
          ? ({ ...current, [card === 'executor' ? 'executor' : 'pi']: result } as SettingsData)
          : nextData,
      )
      void client.invalidateQueries({ queryKey: shellKey })
      setSaved(true)
      notice('设置已保存')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }
  const [title, description, note] = descriptions[card]
  let fields: ReactNode
  if (card === 'codex')
    fields = (
      <div className="form-grid">
        {input('model', '默认模型', { required: true })}
        <fieldset className="field">
          <legend>推理强度</legend>
          <div className="seg">
            {['low', 'medium', 'high', 'xhigh'].map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="effort"
                  value={value}
                  checked={draft.effort === value}
                  onChange={() => update('effort', value)}
                />
                <span>{value}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    )
  else if (card === 'pi')
    fields = (
      <div className="form-grid">
        {input('piModel', 'Pi 模型', { hint: '留空使用 Pi 默认模型' })}
        <label className="field">
          LLM API
          <select value={draft.llmApi} onChange={(e) => update('llmApi', e.target.value)}>
            <option>openai-responses</option>
            <option>openai-completions</option>
          </select>
        </label>
        {input('llmBaseUrl', 'LLM 接入地址', {
          span: true,
          hint: 'Docker 执行器必填：容器内通过它访问模型',
        })}
        <div className="field span-2">
          {data.pi.llmApiKey && (
            <div className="secret">
              <span className="mono">{data.pi.llmApiKey}</span>
              <span className="muted small">已设置</span>
              <button
                className="button button--sm"
                type="button"
                disabled={pending}
                onClick={() => {
                  if (confirm('确认清除 LLM Key？')) void save({ llmApiKey: null }, true)
                }}
              >
                清除 Key
              </button>
            </div>
          )}
          <label>
            LLM Key
            <input
              name="llmApiKey"
              type="password"
              autoComplete="new-password"
              placeholder={data.pi.llmApiKey ?? '未设置'}
              value={draft.llmApiKey}
              onChange={(e) => update('llmApiKey', e.target.value)}
            />
            <small>留空表示不修改</small>
          </label>
        </div>
      </div>
    )
  else if (card === 'git')
    fields = (
      <div className="form-grid">
        {input('gitName', 'Git 名称', { required: true })}
        {input('gitEmail', 'Git 邮箱', { type: 'email', required: true })}
      </div>
    )
  else
    fields = (
      <div className="card-body stack">
        <div className="choice">
          {['none', 'docker'].map((value) => (
            <label className={`opt${draft.sandbox === value ? ' on' : ''}`} key={value}>
              <input
                type="radio"
                name="sandbox"
                value={value}
                checked={draft.sandbox === value}
                onChange={() => update('sandbox', value)}
              />
              <span>
                <b>{value === 'none' ? '本机进程' : 'Docker 容器'}</b>
                <small>
                  {value === 'none'
                    ? 'task 以子进程运行，无外层沙箱'
                    : '每个任务一个容器，限制 CPU、内存与进程数'}
                </small>
              </span>
            </label>
          ))}
        </div>
        <div className="warn-box">
          Docker 需本机已构建任务镜像，且已在「Pi 与 LLM
          接入」填写接入地址；切换只影响之后拉起的任务
        </div>
        {input('concurrency', '并发上限', {
          type: 'number',
          min: '1',
          max: '32',
          step: '1',
          required: true,
          hint: '同时运行的任务数，保存后下一轮轮询生效',
        })}
        <fieldset className={`form-grid${draft.sandbox === 'none' ? ' muted-fieldset' : ''}`}>
          {input('taskImage', '镜像', { span: true, required: true })}
          {input('taskCpus', 'CPU', {
            type: 'number',
            step: '0.1',
            min: '0.1',
            max: '64',
            required: true,
          })}
          {input('taskMemory', '内存', { required: true, hint: '如 512m、4g' })}
          {input('taskPids', '进程数上限', {
            type: 'number',
            min: '64',
            max: '65536',
            required: true,
          })}
          {input('taskNetwork', '网络', { hint: '留空表示 Docker 默认' })}
        </fieldset>
      </div>
    )
  return (
    <section id={`set-${card}`}>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          void save(cardBody(card, draft))
        }}
      >
        <div className="card-head">
          <div>
            <h2>{title}</h2>
            <p className="small muted">{description}</p>
          </div>
          {card === 'pi' && (
            <span className={`badge badge--${data.pi.llmBaseUrl ? 'done' : 'canceled'}`}>
              {data.pi.llmBaseUrl ? '已配置' : '未配置'}
            </span>
          )}
        </div>
        {fields}
        <div className={`card-foot${dirty ? ' dirty' : ''}`}>
          <span className="small muted">{dirty ? '有未保存的修改' : saved ? '已保存' : note}</span>
          <div className="actions">
            <button
              className="button button--sm"
              type="button"
              onClick={() => {
                setDraft(baseline)
                setError('')
                setSaved(false)
              }}
            >
              撤销
            </button>
            <button className="button button--primary button--sm" type="submit" disabled={pending}>
              {card === 'executor' ? '保存执行器设置' : '保存'}
            </button>
          </div>
        </div>
        <div className="error-box" role="alert" hidden={!error}>
          {error}
        </div>
      </form>
    </section>
  )
}
function PasswordCard({ notice }: { notice: (s: string) => void }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const values = new FormData(form)
    const currentPassword = String(values.get('currentPassword'))
    const newPassword = String(values.get('newPassword'))
    setError('')
    if (newPassword !== values.get('confirmPassword')) {
      setError('两次输入的新密码不一致')
      return
    }
    setPending(true)
    try {
      await repoRequest('/api/password', 'POST', { currentPassword, newPassword })
      setSaved(true)
      notice('密码已修改，其他会话已退出')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      form.reset()
      setPending(false)
    }
  }
  return (
    <section id="set-password">
      <form className="card" onSubmit={(e) => void submit(e)} onChange={() => setSaved(false)}>
        <div className="card-head">
          <div>
            <h2>管理密码</h2>
            <p className="small muted">修改后其他已登录设备需要重新登录</p>
          </div>
        </div>
        <div className="form-grid">
          {[
            ['currentPassword', '当前密码', 'current-password'],
            ['newPassword', '新密码', 'new-password'],
            ['confirmPassword', '确认新密码', 'new-password'],
          ].map(([name, label, autoComplete]) => (
            <label className="field" key={name}>
              {label}
              <input name={name} type="password" autoComplete={autoComplete} required />
            </label>
          ))}
        </div>
        <div className="card-foot">
          {saved && <span className="small muted">已保存</span>}
          <button className="button button--primary button--sm" type="submit" disabled={pending}>
            修改密码
          </button>
        </div>
        <div className="error-box" role="alert" hidden={!error}>
          {error}
        </div>
      </form>
    </section>
  )
}
