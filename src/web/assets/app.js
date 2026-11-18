export function init(root, ctx) {
  const controller = new AbortController()
  let disposed = false
  const timers = new Set()
  const on = (node, type, handler) =>
    node?.addEventListener(type, handler, { signal: controller.signal })
  const later = (callback, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed) callback()
    }, ms)
    timers.add(timer)
  }
  const navigate = (url) => {
    if (!disposed) ctx.navigate(url)
  }
  async function request(path, method, body) {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 401) {
      location.assign('/login')
      throw new Error('未登录')
    }
    if (!response.ok) throw new Error((await response.json()).error || '操作失败')
    return response
  }
  root.querySelectorAll('[role="switch"]').forEach((button) =>
    on(button, 'click', async () => {
      const enabled = button.getAttribute('aria-checked') !== 'true'
      try {
        await request(`/api/repos/${button.dataset.repoId}`, 'PATCH', { enabled })
        navigate(`/repos?notice=${enabled ? 'enabled' : 'disabled'}`)
      } catch (error) {
        if (disposed) return
        alert(error.message)
      }
    }),
  )
  root.querySelectorAll('[data-token-toggle]').forEach((button) =>
    on(button, 'click', () => {
      const row = root.querySelector(`#token-form-${button.dataset.tokenToggle}`)
      row.hidden = !row.hidden
    }),
  )
  root.querySelectorAll('.token-form').forEach((form) =>
    on(form, 'submit', async (event) => {
      event.preventDefault()
      try {
        await request(`/api/repos/${form.dataset.repoId}`, 'PATCH', {
          token: form.elements.token.value,
        })
        navigate('/repos?notice=token')
      } catch (error) {
        if (disposed) return
        form.querySelector('[role="alert"]').textContent = error.message
      }
    }),
  )
  root.querySelectorAll('[data-delete]').forEach((button) =>
    on(button, 'click', async () => {
      if (
        prompt(`输入 ${button.dataset.ref} 确认删除；该仓库的 Issue 记录会一并删除`) !==
        button.dataset.ref
      )
        return
      try {
        await request(`/api/repos/${button.dataset.repoId}`, 'DELETE')
        navigate('/repos?notice=deleted')
      } catch (error) {
        if (disposed) return
        alert(error.message)
      }
    }),
  )
  on(root.querySelector('#add-form'), 'submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const errorBox = root.querySelector('#add-error')
    errorBox.hidden = true
    try {
      await request('/api/repos', 'POST', {
        ref: form.elements.ref.value,
        token: form.elements.token.value,
        enabled: form.elements.enabled.checked,
      })
      navigate('/repos?notice=added')
    } catch (error) {
      if (disposed) return
      errorBox.textContent = error.message
      errorBox.hidden = false
    }
  })
  root.querySelectorAll('form[data-settings]').forEach((form) => {
    const snapshot = () => JSON.stringify([...new FormData(form)])
    const initial = snapshot()
    const foot = form.querySelector('.card-foot')
    const label = foot.querySelector('[data-dirty-label]')
    const note = label.textContent
    const update = () => {
      const dirty = snapshot() !== initial
      foot.classList.toggle('dirty', dirty)
      label.textContent = dirty ? '有未保存的修改' : note
      if (form.dataset.settings === 'executor') {
        form
          .querySelectorAll('.opt')
          .forEach((opt) => opt.classList.toggle('on', opt.querySelector('input').checked))
        form
          .querySelector('[data-docker-only]')
          .classList.toggle('muted-fieldset', form.elements.sandbox.value === 'none')
      }
    }
    on(form, 'input', update)
    on(form, 'change', update)
    on(form, 'reset', () => later(update, 0))
    on(form, 'submit', async (event) => {
      event.preventDefault()
      const errorBox = form.querySelector('[role="alert"]')
      errorBox.hidden = true
      const body = {}
      for (const [key, value] of new FormData(form)) {
        if (form.dataset.settings === 'pi') {
          if (['model', 'effort', 'gitName', 'gitEmail', 'llmApi'].includes(key)) body[key] = value
          else if (['piModel', 'llmBaseUrl'].includes(key)) body[key] = value || null
          else if (key === 'llmApiKey' && value !== '') body[key] = value
        } else {
          body[key] = ['concurrency', 'taskCpus', 'taskPids'].includes(key)
            ? Number(value)
            : key === 'taskNetwork'
              ? value || null
              : value
        }
      }
      try {
        await request(`/api/settings/${form.dataset.settings}`, 'PATCH', body)
        navigate('/settings?notice=saved#' + form.closest('section').id)
      } catch (error) {
        if (disposed) return
        errorBox.textContent = error.message
        errorBox.hidden = false
      }
    })
  })
  on(root.querySelector('#password-form'), 'submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const errorBox = form.querySelector('.error-box')
    errorBox.hidden = true
    const currentPassword = form.elements.currentPassword.value
    const newPassword = form.elements.newPassword.value
    if (newPassword !== form.elements.confirmPassword.value) {
      errorBox.textContent = '两次输入的新密码不一致'
      errorBox.hidden = false
      return
    }
    try {
      await request('/api/password', 'POST', { currentPassword, newPassword })
      navigate('/settings?notice=password#set-password')
    } catch (error) {
      if (disposed) return
      errorBox.textContent = error.message
      errorBox.hidden = false
    } finally {
      form.reset()
    }
  })
  on(root.querySelector('[data-clear-key]'), 'click', async (event) => {
    const form = event.currentTarget.closest('form')
    if (!confirm('确认清除 LLM Key？')) return
    try {
      await request('/api/settings/pi', 'PATCH', { llmApiKey: null })
      navigate('/settings?notice=saved#set-pi')
    } catch (error) {
      if (disposed) return
      const errorBox = form.querySelector('[role="alert"]')
      errorBox.textContent = error.message
      errorBox.hidden = false
    }
  })
  root
    .querySelectorAll('[data-open]')
    .forEach((button) =>
      on(button, 'click', () => root.querySelector(`#${button.dataset.open}`).showModal()),
    )
  root
    .querySelectorAll('[data-close]')
    .forEach((button) => on(button, 'click', () => button.closest('dialog').close()))
  if (location.hash === '#add') root.querySelector('#add-dialog')?.showModal()
  root.querySelectorAll('[data-copy]').forEach((button) =>
    on(button, 'click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy)
      if (disposed) return
      const label = button.textContent
      button.textContent = '已复制'
      later(() => {
        button.textContent = label
      }, 2000)
    }),
  )
  root
    .querySelectorAll('[data-dismiss]')
    .forEach((button) => on(button, 'click', () => button.parentElement.remove()))
  return () => {
    disposed = true
    controller.abort()
    for (const timer of timers) clearTimeout(timer)
    root.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close())
  }
}
