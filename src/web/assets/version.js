;(() => {
  const pill = document.getElementById('version-pill')
  if (!pill) return
  const panel = document.getElementById('version-popover')
  const el = (id) => document.getElementById(`version-${id}`)
  let info = { current: pill.dataset.current }
  let ready = false
  let checked = false
  let checking = null
  let watching = false
  let submitting = false
  let selection = null
  let expanded = false
  let preparing = false
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const api = async (path, body) => {
    const response = await fetch(`/api/system/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(path === 'version?local=1' || path === 'job' ? 5000 : 35000),
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    if (response.status === 401) {
      location.assign('/login')
      throw new Error('未登录')
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '操作失败')
    return data
  }
  const fail = (error) => {
    el('error').textContent = error.message
    el('error').hidden = false
  }
  const busy = () => watching || submitting || preparing
  const render = () => {
    el('label').textContent = info.current
    el('current').textContent = info.current
    const available = info.hasUpdate && info.current !== 'dev'
    pill.querySelector('.dot').hidden = !available
    pill.title = available ? `发现新版本 ${info.latest.tag}` : '版本与更新'
    let state = 'info',
      description = checked ? '已是最新版本' : '尚未检查更新',
      detail = ''
    if (!ready) {
      description = '正在读取版本信息…'
    } else if (info.mode === 'unsupported') {
      description = '当前部署方式不支持在线更新'
      detail = '请在服务器执行 update.sh'
    } else if (!info.repoConfigured) {
      description = '未配置更新源'
      detail = '在 .env 设置 WORKLING_UPDATE_REPO'
    } else if (info.releaseError) {
      state = 'warning'
      description = info.releaseError
    } else if (info.current === 'dev') {
      description = '开发版本，不参与版本比较'
      detail = info.latest ? `最新发布 ${info.latest.tag}` : ''
    } else if (available) {
      state = 'arrow'
      description = `发现新版本 ${info.latest.tag}`
    } else if (checked && info.latest) state = 'check'
    else if (checked) description = '暂无可用发布'
    el('badge').className = `version-badge version-badge--${state}`
    panel.querySelectorAll('[data-version-icon]').forEach((icon) => {
      icon.hidden = icon.dataset.versionIcon !== state
    })
    el('description').textContent = description
    el('detail').textContent = detail
    el('detail').hidden = !detail
    el('release').hidden = !info.latest || !(available || info.current === 'dev')
    el('notes').textContent = info.latest?.body || ''
    el('notes').classList.remove('expanded')
    const truncated = el('notes').scrollHeight > el('notes').clientHeight
    el('more').hidden =
      !info.latest?.body || (!truncated && info.latest.body.split('\n').length <= 4)
    el('notes').classList.toggle('expanded', expanded)
    el('more').textContent = expanded ? '收起' : '更多'
    el('more').setAttribute('aria-expanded', String(expanded))
    el('update').hidden =
      !available || info.mode !== 'docker' || !info.repoConfigured || Boolean(info.releaseError)
    el('update').textContent = `更新到 ${info.latest?.tag || ''}`
    el('update').disabled = busy() || Boolean(selection)
    // 仅使用服务端校验过的仓库发布页，避免把 Release 正文或 URL 当作 HTML。
    el('link').hidden = !info.releasesUrl
    if (info.releasesUrl) el('link').href = info.releasesUrl
    else el('link').removeAttribute('href')
    el('last-success').hidden = !info.lastSuccess
    el('last-success').textContent = info.lastSuccess
      ? `上次更新：${info.lastSuccess.tag} · ${new Date(info.lastSuccess.at).toLocaleString()}`
      : ''
    el('last-error').hidden = !info.lastError
    el('last-error').textContent = info.lastError || ''
    el('check').disabled = !ready || Boolean(checking) || busy()
    el('check').classList.toggle('loading', Boolean(checking))
  }
  const local = async () => {
    info = { ...info, ...(await api('version?local=1')) }
    ready = true
    render()
    return info
  }
  const check = (force = false) => {
    if (!ready || busy()) return Promise.resolve()
    if (checking) return checking
    checking = (async () => {
      try {
        const result = await api(`version${force ? '?force=1' : ''}`)
        info = { ...info, releaseError: undefined, ...result }
        checked = true
      } catch (error) {
        info.releaseError = error.message
      } finally {
        checking = null
        render()
      }
    })()
    render()
    return checking
  }
  const close = () => {
    panel.hidden = true
    pill.setAttribute('aria-expanded', 'false')
    pill.focus()
  }
  const position = () => {
    if (!pill.getBoundingClientRect) return
    const rect = pill.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 32)
    const top = Math.min(rect.bottom + 6, window.innerHeight - 16)
    panel.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`
    panel.style.top = `${Math.max(0, top)}px`
    panel.style.maxHeight = `${Math.max(0, window.innerHeight - top - 16)}px`
  }
  window.addEventListener?.('resize', () => {
    if (!panel.hidden) position()
  })
  const open = (inspect = true) => {
    panel.hidden = false
    pill.setAttribute('aria-expanded', 'true')
    position()
    render()
    panel.focus()
    if (inspect && !checked && !busy()) void check()
  }
  pill.addEventListener('click', () => (panel.hidden ? open() : close()))
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !pill.contains(event.target)) close()
  })
  document.addEventListener('keydown', (event) => {
    if (!panel.hidden && event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  el('check').addEventListener('click', () => check(true))
  el('more').addEventListener('click', () => {
    expanded = !expanded
    render()
  })
  const watch = async (active) => {
    if (watching) return
    watching = true
    document.body.dataset.refreshPaused = 'true'
    const original = info.current
    selection = null
    el('confirmation').hidden = true
    el('progress').hidden = false
    el('back').hidden = true
    el('error').hidden = true
    open(false)
    render()
    try {
      for (;;) {
        if (active) {
          el('logs').textContent = active.logs.slice(-5).join('\n')
          el('cancel').hidden = active.status !== 'waiting'
          el('status').textContent = active.status === 'waiting' ? '等待任务结束…' : '正在执行…'
          if (active.status === 'failed') throw new Error(active.error || '更新失败')
        }
        if (!active || active.status === 'done') break
        await pause(1500)
        try {
          active = await api('job')
        } catch {
          break
        }
      }
      el('cancel').hidden = true
      el('status').textContent = '正在重启…'
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        await pause(2000)
        try {
          await local()
          if (info.current !== original) {
            el('status').textContent = `已更新到 ${info.current}`
            await pause(1000)
            location.reload()
            return
          }
          if (info.lastError && !info.job)
            throw Object.assign(new Error(info.lastError), { terminal: true })
        } catch (error) {
          if (error.terminal) throw error
        }
      }
      throw new Error('重启时间较长，请稍后刷新页面')
    } catch (error) {
      el('status').textContent = error.message
      el('back').hidden = false
    } finally {
      watching = false
      document.body.dataset.refreshPaused = 'false'
      el('cancel').hidden = true
      render()
    }
  }
  el('back').addEventListener('click', () => {
    el('progress').hidden = true
    el('error').hidden = true
    render()
  })
  const confirm = async () => {
    if (busy()) return
    preparing = true
    render()
    try {
      await local()
      if (info.job && ['running', 'waiting'].includes(info.job.status)) {
        void watch(info.job)
        return
      }
      selection = { tag: info.latest?.tag }
      if (!selection.tag) {
        selection = null
        throw new Error('目标版本不可用，请重新检查更新')
      }
      el('error').hidden = true
      el('progress').hidden = true
      el('confirmation').hidden = false
      el('confirm-title').textContent = `更新到 ${selection.tag}`
      el('confirm-description').textContent = '会备份数据库并重启服务。'
      el('confirm').textContent = '确认更新'
      el('modes').hidden = !info.runningTasks
      el('drain-label').textContent = `等待 ${info.runningTasks} 个运行中任务结束后更新（推荐）`
      panel.querySelector('input[value="drain"]').checked = true
      el('confirm').focus()
    } catch (error) {
      fail(error)
    } finally {
      preparing = false
      render()
    }
  }
  el('update').addEventListener('click', confirm)
  el('dismiss').addEventListener('click', () => {
    selection = null
    el('confirmation').hidden = true
    render()
  })
  el('confirm').addEventListener('click', async () => {
    if (!selection || busy()) return
    submitting = true
    el('confirm').disabled = true
    el('dismiss').disabled = true
    el('error').hidden = true
    render()
    try {
      const mode = panel.querySelector('input[name="version-mode"]:checked').value
      const result = await api('update', {
        mode,
        tag: selection.tag,
      })
      void watch(result.job)
    } catch (error) {
      fail(error)
    } finally {
      submitting = false
      el('confirm').disabled = false
      el('dismiss').disabled = false
      render()
    }
  })
  el('cancel').addEventListener('click', async () => {
    el('cancel').disabled = true
    try {
      const result = await api('job/cancel', {})
      el('status').textContent = result.job.error || '已取消'
    } catch (error) {
      fail(error)
    } finally {
      el('cancel').disabled = false
    }
  })
  local()
    .then(() => {
      if (info.job && ['running', 'waiting'].includes(info.job.status)) void watch(info.job)
      else if (!panel.hidden && !checked) void check()
      else if (info.repoConfigured && info.mode === 'docker') {
        const inspect = () => {
          if (!checked && !busy()) void check()
        }
        if ('requestIdleCallback' in window) window.requestIdleCallback(inspect, { timeout: 3000 })
        else setTimeout(inspect, 1000)
      }
    })
    .catch(fail)
})()
