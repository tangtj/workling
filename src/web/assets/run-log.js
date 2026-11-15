import {
  createTimeline,
  applyWorklingLine,
  applyPiLine,
  applyLogLine,
  phaseOf,
  counts,
  shouldReload,
} from '/timeline.js'

function initTimeline(timeline) {
  const compact = timeline.classList.contains('compact')
  const scope = compact ? timeline : document
  if (compact) {
    const phases = document.createElement('ol')
    phases.className = 'run-phases'
    phases.setAttribute('aria-label', '执行阶段')
    for (const [index, label] of [
      '准备',
      '读取 Issue',
      'codex 实现',
      '核对',
      '交付 PR',
    ].entries()) {
      const phase = document.createElement('li')
      phase.dataset.phase = index
      phase.textContent = label
      phases.append(phase)
    }
    timeline.append(phases)
  }
  const state = createTimeline()
  const nodes = new Map()
  const raw = document.querySelector('#run-log')
  const follow = document.querySelector('#log-follow')
  const live = document.querySelector('#log-live')
  const errorBox = compact ? element('p', 'error-box') : document.querySelector('#log-error')
  if (compact) {
    errorBox.hidden = true
    timeline.append(errorBox)
  }
  let filter = 'all'
  let workling = 0
  let pi = 0
  let ended = false
  const initiallyEnded = timeline.dataset.ended === 'true'
  let exitSeen = false
  const finalWorkling = []
  const url = `/api/runs/${timeline.dataset.runId}`
  async function request(path) {
    const response = await fetch(path)
    if (response.status === 401) {
      location.assign('/login')
      throw new Error('未登录')
    }
    if (!response.ok) throw new Error((await response.json()).error || '加载失败')
    return response
  }
  function showError(error) {
    errorBox.textContent = error.message
    errorBox.hidden = false
  }
  function element(tag, className, text) {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  function duration(ms) {
    const seconds = Math.floor(Math.max(0, ms) / 1000)
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  }
  function visible(item) {
    return (
      filter === 'all' ||
      (filter === 'command' && ['command', 'codex'].includes(item.kind)) ||
      item.kind === filter ||
      (filter === 'error' && (item.status === 'error' || item.kind === 'warning'))
    )
  }
  function elapsed(item) {
    return duration(
      item.status === 'running' && !ended && item.startedAt
        ? Date.now() - new Date(item.startedAt).getTime()
        : (item.durationMs ?? 0),
    )
  }
  function updateMeta(view, item) {
    const exitStatus =
      item.kind === 'exit'
        ? item.signal || (item.code !== undefined && item.code !== 0)
          ? 'error'
          : item.code === 0
            ? 'ok'
            : ''
        : ''
    const status = item.status || exitStatus
    view.root.dataset.status = status
    view.status.dataset.status = status
    view.status.textContent =
      status === 'ok' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '运行中' : ''
    const time = item.ts
      ? /^\d\d:\d\d:\d\d$/.test(item.ts)
        ? item.ts
        : new Date(item.ts).toLocaleTimeString()
      : ''
    view.metaTime.textContent = [
      item.kind === 'codex' ? '' : time,
      item.durationMs !== undefined || item.status ? elapsed(item) : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  function createEntry(item) {
    const root = element('article', `timeline-entry timeline-entry--${item.kind}`)
    if (item.kind === 'output') {
      const output = element('pre', 'mono')
      const details = element('details', 'timeline-details')
      const summary = element('summary', '')
      const rest = element('pre', 'mono')
      details.append(summary, rest)
      root.append(output, details)
      timeline.append(root)
      return { root, output, details, summary, rest }
    }
    const icons = {
      step: '⎇',
      command: '$',
      file: item.action === '读取' ? '⌕' : '✎',
      message: '”',
      codex: '◆',
      warning: '!',
      exit: '■',
      tool: '⎇',
    }
    const icon = element('span', 'timeline-icon', icons[item.kind])
    icon.setAttribute('aria-hidden', 'true')
    const body = element('div', 'timeline-body')
    const row = element(item.kind === 'command' ? 'summary' : 'div', 'timeline-row')
    const heading = element('span', `timeline-heading${item.kind === 'command' ? ' mono' : ''}`)
    const model = item.kind === 'codex' ? element('span', 'timeline-model mono') : null
    const meta = element('span', 'timeline-meta')
    const status = element('span', 'timeline-status')
    const metaTime = element('span', 'timeline-meta-time')
    meta.append(status, metaTime)
    row.append(heading)
    if (model) row.append(model)
    row.append(meta)
    root.append(icon, body)
    let output, latest
    if (item.kind === 'command') {
      const details = element('details', 'timeline-command')
      output = element('pre', 'mono')
      details.append(row, element('pre', 'mono', item.command), output)
      body.append(details)
    } else {
      body.append(row)
      if (item.kind === 'codex') {
        body.classList.add('timeline-codex-card')
        latest = element('p', 'timeline-latest mono')
        const details = element('details', 'timeline-details')
        output = element('pre', 'mono')
        details.append(
          element('summary', '', '展开 codex 输出'),
          element('pre', 'mono', item.command),
          output,
        )
        body.append(latest, details)
      }
    }
    timeline.append(root)
    return { root, icon, heading, metaTime, status, model, output, latest }
  }
  function render() {
    let added = false
    for (const [index, item] of state.items.entries()) {
      let view = nodes.get(item.id)
      if (!view) {
        view = createEntry(item)
        nodes.set(item.id, view)
        added = true
      }
      timeline.append(view.root)
      view.root.hidden =
        !visible(item) || (compact && index < state.items.length - Number(timeline.dataset.limit))
      if (item.kind === 'output') {
        view.output.textContent = item.lines.slice(0, 6).join('\n')
        view.rest.textContent = item.lines.slice(6).join('\n')
        view.details.hidden = item.lines.length <= 6
        view.summary.textContent = `展开全部（共 ${item.lines.length} 行）`
        view.root.dataset.status =
          ['failed', 'canceled'].includes(timeline.dataset.status) &&
          state.items[index + 1]?.kind === 'exit'
            ? 'error'
            : ''
        continue
      }
      const lines = item.command?.split('\n')
      const label =
        item.kind === 'codex'
          ? 'codex exec'
          : item.kind === 'command'
            ? `${lines[0]}${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`
            : item.kind === 'file'
              ? `${item.action} ${item.path}`
              : item.kind === 'tool'
                ? `调用 ${item.name}`
                : item.kind === 'exit'
                  ? (item.text ??
                    `Pi 结束 · ${item.signal ? `信号 ${item.signal}` : `退出码 ${item.code}`}`)
                  : item.text
      // 保留条目和 details 节点，轮询时不丢失展开状态。
      if (view.heading.textContent !== label) view.heading.textContent = label
      updateMeta(view, item)
      if (item.status === 'error') view.icon.textContent = '!'
      if (view.model) view.model.textContent = `${item.model || '默认'} · ${item.effort || '默认'}`
      if (view.output && view.output.textContent !== item.output)
        view.output.textContent = item.output
      if (view.latest) view.latest.textContent = `最新：${item.latest || '等待输出'}`
    }
    const totals = counts(state)
    scope.querySelectorAll('[data-count]').forEach((node) => {
      node.textContent = totals[node.dataset.count]
    })
    const phase = phaseOf(state)
    const failed =
      ended &&
      (['failed', 'canceled'].includes(timeline.dataset.status) ||
        state.items.some(
          (i) => i.kind === 'exit' && (i.signal || (i.code !== undefined && i.code !== 0)),
        ))
    scope.querySelectorAll('[data-phase]').forEach((node) => {
      const index = Number(node.dataset.phase)
      const complete = index < phase || (index === phase && ended && !failed)
      const current = index === phase
      const badge = complete ? 'done' : current ? (failed ? 'failed' : 'running') : ''
      node.className = `badge${badge ? ` badge--${badge}` : ''}`
      const label = ['准备', '读取 Issue', 'codex 实现', '核对', '交付 PR'][index]
      node.textContent = `${complete ? '✓ ' : current ? (failed ? '✗ ' : '● ') : ''}${label}`
      if (current) node.setAttribute('aria-current', 'step')
      else node.removeAttribute('aria-current')
    })
    if (added && !compact && follow.checked && !timeline.hidden)
      timeline.scrollIntoView({ block: 'end' })
  }
  scope.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter
      document
        .querySelectorAll('[data-filter]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
      for (const item of state.items) nodes.get(item.id).root.hidden = !visible(item)
    })
  })
  const timer = setInterval(() => {
    for (const item of state.items) {
      if (item.kind === 'codex' && item.status === 'running') {
        const view = nodes.get(item.id)
        updateMeta(view, item)
      }
    }
  }, 1000)
  let fallbackNotice
  let fallbackText = null
  function showFallbackNotice() {
    if (!fallbackNotice) {
      fallbackNotice = element('p', 'muted', '此次执行没有结构化事件，以下由文本日志整理')
      timeline.prepend(fallbackNotice)
    }
  }
  async function loadEvents() {
    try {
      const response = await (await request(`${url}/events?workling=${workling}&pi=${pi}`)).json()
      let fallbackProgressed = false
      if (response.fallback) {
        const nextText = response.fallback.lines.join('\n')
        fallbackProgressed = nextText !== fallbackText
        fallbackText = nextText
        Object.assign(state, createTimeline())
        response.fallback.lines.forEach((line, index, lines) => {
          if (index < lines.length - 1 || line !== '') applyLogLine(state, line)
        })
        for (const [id, view] of nodes) {
          const item = state.items.find((item) => item.id === id)
          if (!item || !view.root.classList.contains(`timeline-entry--${item.kind}`)) {
            view.root.remove()
            nodes.delete(id)
          }
        }
        showFallbackNotice()
      } else if (fallbackText !== null) {
        Object.assign(state, createTimeline())
        for (const view of nodes.values()) view.root.remove()
        nodes.clear()
        fallbackNotice.remove()
        fallbackNotice = null
        fallbackText = null
      }
      const progressed =
        fallbackProgressed ||
        response.workling.offset !== workling ||
        (!response.fallback && response.pi.offset !== pi)
      for (const line of response.workling.lines) {
        // 两个文件没有公共序号；将结束事件延后到本批 Pi 事件排空之后。
        try {
          if (JSON.parse(line).type === 'pi_exit') exitSeen = true
        } catch {
          /* 坏行由模型忽略。 */
        }
        if (exitSeen) finalWorkling.push(line)
        else applyWorklingLine(state, line)
      }
      if (!response.fallback) response.pi.lines.forEach((line) => applyPiLine(state, line))
      workling = response.workling.offset
      pi = response.fallback ? 0 : response.pi.offset
      const finished = response.ended
      if (!progressed) finalWorkling.splice(0).forEach((line) => applyWorklingLine(state, line))
      const stop = finished && ended && !progressed
      const reload = shouldReload(initiallyEnded, finished, ended, progressed)
      ended = finished
      render()
      if (stop) {
        clearInterval(timer)
        if (live) live.hidden = true
        if (!compact && reload) location.reload()
        return
      }
      setTimeout(loadEvents, finished ? 0 : 3000)
    } catch (error) {
      clearInterval(timer)
      if (compact && error.message === '日志已清理' && timeline.dataset.logTail) {
        Object.assign(state, createTimeline())
        for (const view of nodes.values()) view.root.remove()
        nodes.clear()
        timeline.dataset.logTail.split(/\r?\n/).forEach((line) => applyLogLine(state, line))
        ended = true
        showFallbackNotice()
        render()
      } else showError(error)
    }
  }
  let rawStarted = false
  let rawOffset = 0
  let rawEnded = false
  let rawHasContent = false
  const decoder = new TextDecoder()
  async function loadRaw() {
    try {
      const response = await request(`${url}/log?offset=${rawOffset}`)
      const content = decoder.decode(await response.arrayBuffer(), { stream: true })
      if (content) {
        if (!rawHasContent) raw.textContent = ''
        rawHasContent = true
        raw.append(document.createTextNode(content))
      } else if (!rawHasContent) raw.textContent = '暂无原始日志'
      const next = Number(response.headers.get('X-Log-Offset'))
      const progressed = next !== rawOffset
      rawOffset = next
      if (follow.checked) raw.scrollTop = raw.scrollHeight
      const finished = response.headers.get('X-Run-Ended') === 'true'
      if (finished && rawEnded && !progressed) {
        raw.append(document.createTextNode(decoder.decode()))
        return
      }
      rawEnded = finished
      setTimeout(loadRaw, progressed || finished ? 0 : 3000)
    } catch (error) {
      raw.textContent = error.message
    }
  }
  if (!compact)
    document.querySelector('#log-raw-toggle').addEventListener('click', (event) => {
      raw.hidden = !raw.hidden
      timeline.hidden = !raw.hidden
      event.currentTarget.setAttribute('aria-pressed', String(!raw.hidden))
      if (!rawStarted) {
        rawStarted = true
        loadRaw()
      }
    })
  loadEvents()
}

for (const timeline of document.querySelectorAll('.run-timeline')) {
  const details = timeline.closest('.run-process')
  if (!details || details.open) initTimeline(timeline)
  else {
    const load = () => {
      if (!details.open) return
      details.removeEventListener('toggle', load)
      initTimeline(timeline)
    }
    details.addEventListener('toggle', load)
  }
}
