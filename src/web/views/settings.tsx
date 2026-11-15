import type { Child } from 'hono/jsx'
import type { ExecutorSettings } from '../../config/executor.ts'
import type { PiSettings } from '../../config/pi.ts'
import { WORKLING_LABELS } from '../../serve/poll.ts'
import type { AppOptions } from '../app.ts'
import type { PageData } from '../data.ts'

function SettingsCard({
  id,
  formId,
  kind,
  title,
  description,
  note,
  badge,
  children,
}: {
  id: string
  formId: string
  kind: string
  title: string
  description: string
  note: string
  badge?: Child
  children: Child
}) {
  return (
    <section id={id}>
      <form id={formId} data-settings={kind} class="card">
        <div class="card-head">
          <div>
            <h2>{title}</h2>
            <p class="small muted">{description}</p>
          </div>
          {badge}
        </div>
        {children}
        <div class="card-foot">
          <span class="small muted" data-dirty-label>
            {note}
          </span>
          <div class="actions">
            <button class="button button--sm" type="reset">
              撤销
            </button>
            <button class="button button--primary button--sm" type="submit">
              {kind === 'executor' ? '保存执行器设置' : '保存'}
            </button>
          </div>
        </div>
        <div class="error-box" role="alert" hidden></div>
      </form>
    </section>
  )
}

export function SettingsPage({
  pi,
  executor,
  notice,
  startup,
}: {
  data: PageData
  pi: PiSettings
  executor: ExecutorSettings
  notice: string
  startup?: AppOptions['startup']
}) {
  const sections = [
    ['set-codex', 'Codex'],
    ['set-pi', 'Pi 与 LLM'],
    ['set-git', '提交身份'],
    ['set-executor', '执行器'],
    ['set-password', '管理密码'],
    ['set-env', '启动参数'],
    ['set-labels', '标签与命令'],
  ]
  const startupRows = startup
    ? [
        ['WORKLING_WORKSPACE', startup.workspace, '工作区与数据库'],
        ['WORKLING_WORKER', startup.worker, '写入评论与运行记录'],
        ['WORKLING_HOST / WORKLING_PORT', `${startup.host}:${startup.port}`, '管理页监听地址'],
        ['WORKLING_ALLOWED_HOSTS', startup.allowedHosts.join(', ') || '未设置', '额外放行的域名'],
        ['WORKLING_SECURE_COOKIE', String(startup.secureCookie), 'HTTPS 部署时开启'],
      ]
    : []
  return (
    <>
      <header class="page-head">
        <div>
          <h1>设置</h1>
          <p>保存后下一轮轮询生效，运行中的任务不受影响</p>
        </div>
      </header>
      {notice === 'saved' && (
        <div class="notice" role="status">
          设置已保存
          <button type="button" data-dismiss>
            关闭
          </button>
        </div>
      )}
      {notice === 'password' && (
        <div class="notice" role="status">
          密码已修改，其他会话已退出
          <button type="button" data-dismiss>
            关闭
          </button>
        </div>
      )}
      <div class="settings">
        <nav class="subnav" aria-label="设置分区">
          {sections.map(([id, title], index) => (
            <a class={index === 5 ? 'subnav-divider' : ''} href={`#${id}`}>
              {title}
            </a>
          ))}
        </nav>
        <div class="stack">
          <SettingsCard
            id="set-codex"
            formId="codex-form"
            kind="pi"
            title="Codex"
            description="实现 Issue 时使用的默认模型与推理强度"
            note="保存后下一轮轮询生效"
          >
            <div class="form-grid">
              <label class="field">
                默认模型
                <input name="model" value={pi.model} required />
              </label>
              <fieldset class="field">
                <legend>推理强度</legend>
                <div class="seg">
                  {(['low', 'medium', 'high', 'xhigh'] as const).map((value) => (
                    <label>
                      <input
                        type="radio"
                        name="effort"
                        value={value}
                        checked={pi.effort === value}
                      />
                      <span>{value}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </SettingsCard>
          <SettingsCard
            id="set-pi"
            formId="pi-settings-form"
            kind="pi"
            title="Pi 与 LLM 接入"
            description="Pi 负责组装提示词、核对和交付 PR"
            note="留空 Key 表示不修改"
            badge={
              <span class={`badge badge--${pi.llmBaseUrl ? 'done' : 'canceled'}`}>
                {pi.llmBaseUrl ? '已配置' : '未配置'}
              </span>
            }
          >
            <div class="form-grid">
              <label class="field">
                Pi 模型
                <input name="piModel" value={pi.piModel ?? ''} />
                <small>留空使用 Pi 默认模型</small>
              </label>
              <label class="field">
                LLM API
                <select name="llmApi">
                  {(['openai-responses', 'openai-completions'] as const).map((value) => (
                    <option value={value} selected={pi.llmApi === value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field span-2">
                LLM 接入地址
                <input name="llmBaseUrl" value={pi.llmBaseUrl ?? ''} />
                <small>Docker 执行器必填：容器内通过它访问模型</small>
              </label>
              <div class="field span-2">
                {pi.llmApiKey && (
                  <div class="secret">
                    <span class="mono">{pi.llmApiKey}</span>
                    <span class="muted small">已设置</span>
                    <button class="button button--sm" type="button" data-clear-key>
                      清除 Key
                    </button>
                  </div>
                )}
                <label>
                  LLM Key
                  <input
                    name="llmApiKey"
                    type="password"
                    autocomplete="new-password"
                    placeholder={pi.llmApiKey ?? '未设置'}
                  />
                  <small>留空表示不修改</small>
                </label>
              </div>
            </div>
          </SettingsCard>
          <SettingsCard
            id="set-git"
            formId="git-form"
            kind="pi"
            title="提交身份"
            description="Pi 提交代码时的作者信息"
            note="PR 作者仍是仓库 token 对应的账号"
          >
            <div class="form-grid">
              <label class="field">
                Git 名称
                <input name="gitName" value={pi.gitName} required />
              </label>
              <label class="field">
                Git 邮箱
                <input name="gitEmail" type="email" value={pi.gitEmail} required />
              </label>
            </div>
          </SettingsCard>
          <SettingsCard
            id="set-executor"
            formId="executor-settings-form"
            kind="executor"
            title="执行器"
            description="切换只影响之后拉起的任务；Docker 需本机已构建镜像且已配置 LLM 接入地址"
            note="本机进程模式下容器参数不生效"
          >
            <div class="card-body stack">
              <div class="choice">
                {(['none', 'docker'] as const).map((value) => (
                  <label class={`opt${executor.sandbox === value ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="sandbox"
                      value={value}
                      checked={executor.sandbox === value}
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
              <div class="warn-box">
                Docker 需本机已构建任务镜像，且已在「Pi 与 LLM
                接入」填写接入地址；切换只影响之后拉起的任务
              </div>
              <label class="field">
                并发上限
                <input
                  name="concurrency"
                  type="number"
                  min="1"
                  max="32"
                  step="1"
                  value={executor.concurrency}
                  required
                />
                <small>同时运行的任务数，保存后下一轮轮询生效</small>
              </label>
              <fieldset
                class={`form-grid${executor.sandbox === 'none' ? ' muted-fieldset' : ''}`}
                data-docker-only
              >
                <label class="field span-2">
                  镜像
                  <input name="taskImage" value={executor.taskImage} required />
                </label>
                <label class="field">
                  CPU
                  <input
                    name="taskCpus"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="64"
                    value={executor.taskCpus}
                    required
                  />
                </label>
                <label class="field">
                  内存
                  <input name="taskMemory" value={executor.taskMemory} required />
                  <small>如 512m、4g</small>
                </label>
                <label class="field">
                  进程数上限
                  <input
                    name="taskPids"
                    type="number"
                    min="64"
                    max="65536"
                    value={executor.taskPids}
                    required
                  />
                </label>
                <label class="field">
                  网络
                  <input name="taskNetwork" value={executor.taskNetwork ?? ''} />
                  <small>留空表示 Docker 默认</small>
                </label>
              </fieldset>
            </div>
          </SettingsCard>
          <section id="set-password">
            <form id="password-form" class="card">
              <div class="card-head">
                <div>
                  <h2>管理密码</h2>
                  <p class="small muted">修改后其他已登录设备需要重新登录</p>
                </div>
              </div>
              <div class="form-grid">
                <label class="field">
                  当前密码
                  <input
                    name="currentPassword"
                    type="password"
                    autocomplete="current-password"
                    required
                  />
                </label>
                <label class="field">
                  新密码
                  <input name="newPassword" type="password" autocomplete="new-password" required />
                </label>
                <label class="field">
                  确认新密码
                  <input
                    name="confirmPassword"
                    type="password"
                    autocomplete="new-password"
                    required
                  />
                </label>
              </div>
              <div class="card-foot">
                <button class="button button--primary button--sm" type="submit">
                  修改密码
                </button>
              </div>
              <div class="error-box" role="alert" hidden></div>
            </form>
          </section>
          <section class="card" id="set-env">
            <div class="card-head">
              <div>
                <h2>启动参数</h2>
                <p class="muted small">只能在 .env 中修改，重启 serve 生效</p>
              </div>
              <span class="badge badge--canceled">只读</span>
            </div>
            {startup ? (
              <div class="kv">
                {startupRows.map(([key, value, description]) => (
                  <>
                    <div class="k">{key}</div>
                    <div class="mono small">{value}</div>
                    <div class="d">{description}</div>
                  </>
                ))}
              </div>
            ) : (
              <p class="empty">未提供启动参数</p>
            )}
          </section>
          <section class="grid g-2" id="set-labels">
            <div class="card">
              <div class="card-head">
                <h2>状态标签</h2>
                <span class="small muted">只有 watch 改标签</span>
              </div>
              <div class="labels">
                {WORKLING_LABELS.map((label) => (
                  <div class="lbl">
                    <span class={`gh-label gh-label--${label.name.slice(6)}`}>{label.name}</span>
                    <span>{label.description}</span>
                  </div>
                ))}
              </div>
            </div>
            <div class="card">
              <div class="card-head">
                <h2>运维命令</h2>
              </div>
              <div class="cmds">
                {[
                  ['启动服务', 'bun run start'],
                  ['取消任务', 'workling cancel github:owner/repo#12'],
                  ['重置密码', 'workling reset-password'],
                ].map(([label, command]) => (
                  <div class="cmd">
                    <span>{label}</span>
                    <code>{command}</code>
                    <button class="button button--sm" type="button" data-copy={command}>
                      复制
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
