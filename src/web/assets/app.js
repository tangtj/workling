async function request(path, method, body, signal) {
  const response = await fetch(path, {
    method,
    signal,
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
document.querySelector('#logout')?.addEventListener('click', async () => {
  await request('/logout', 'POST', {})
  location.assign('/login')
})
document.querySelectorAll('[role="switch"]').forEach((button) =>
  button.addEventListener('click', async () => {
    const enabled = button.getAttribute('aria-checked') !== 'true'
    try {
      await request(`/api/repos/${button.dataset.repoId}`, 'PATCH', { enabled })
      location.assign(`/repos?notice=${enabled ? 'enabled' : 'disabled'}`)
    } catch (error) {
      alert(error.message)
    }
  }),
)
document.querySelectorAll('[data-token-toggle]').forEach((button) =>
  button.addEventListener('click', () => {
    const row = document.getElementById(`token-form-${button.dataset.tokenToggle}`)
    row.hidden = !row.hidden
  }),
)
document.querySelectorAll('.token-form').forEach((form) =>
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await request(`/api/repos/${form.dataset.repoId}`, 'PATCH', {
        token: form.elements.token.value,
      })
      location.assign('/repos?notice=token')
    } catch (error) {
      form.querySelector('[role="alert"]').textContent = error.message
    }
  }),
)
document.querySelectorAll('[data-delete]').forEach((button) =>
  button.addEventListener('click', async () => {
    if (
      prompt(`输入 ${button.dataset.ref} 确认删除；该仓库的 Issue 记录会一并删除`) !==
      button.dataset.ref
    )
      return
    try {
      await request(`/api/repos/${button.dataset.repoId}`, 'DELETE')
      location.assign('/repos?notice=deleted')
    } catch (error) {
      alert(error.message)
    }
  }),
)
document.querySelector('#add-form')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const errorBox = document.querySelector('#add-error')
  errorBox.hidden = true
  try {
    await request('/api/repos', 'POST', {
      ref: form.elements.ref.value,
      token: form.elements.token.value,
      enabled: form.elements.enabled.checked,
    })
    location.assign('/repos?notice=added')
  } catch (error) {
    errorBox.textContent = error.message
    errorBox.hidden = false
  }
})
document.querySelectorAll('form[data-settings]').forEach((form) => {
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
  form.addEventListener('input', update)
  form.addEventListener('change', update)
  form.addEventListener('reset', () => setTimeout(update, 0))
  form.addEventListener('submit', async (event) => {
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
      location.assign('/settings?notice=saved#' + form.closest('section').id)
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    }
  })
})
document.querySelector('#password-form')?.addEventListener('submit', async (event) => {
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
    const response = await fetch('/api/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (!response.ok) throw new Error((await response.json()).error || '操作失败')
    location.assign('/settings?notice=password#set-password')
  } catch (error) {
    errorBox.textContent = error.message
    errorBox.hidden = false
  } finally {
    form.reset()
  }
})
document.querySelector('[data-clear-key]')?.addEventListener('click', async (event) => {
  const form = event.currentTarget.closest('form')
  if (!confirm('确认清除 LLM Key？')) return
  try {
    await request('/api/settings/pi', 'PATCH', { llmApiKey: null })
    location.assign('/settings?notice=saved#set-pi')
  } catch (error) {
    const errorBox = form.querySelector('[role="alert"]')
    errorBox.textContent = error.message
    errorBox.hidden = false
  }
})
document
  .querySelectorAll('[data-open]')
  .forEach((button) =>
    button.addEventListener('click', () =>
      document.getElementById(button.dataset.open).showModal(),
    ),
  )
document
  .querySelectorAll('[data-close]')
  .forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()))
if (location.hash === '#add') document.querySelector('#add-dialog')?.showModal()
window.addEventListener('hashchange', () => {
  const dialog = document.querySelector('#add-dialog')
  if (location.hash === '#add' && dialog && !dialog.open) dialog.showModal()
})
const issueFilter = document.querySelector('#issue-filter')
issueFilter?.addEventListener('submit', (event) => {
  event.preventDefault()
  location.assign(`/issues?${new URLSearchParams(new FormData(issueFilter))}`)
})
issueFilter?.querySelector('select').addEventListener('change', () => issueFilter.requestSubmit())
document.querySelectorAll('[data-copy]').forEach((button) =>
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy)
    const label = button.textContent
    button.textContent = '已复制'
    setTimeout(() => {
      button.textContent = label
    }, 2000)
  }),
)
document
  .querySelectorAll('[data-dismiss]')
  .forEach((button) => button.addEventListener('click', () => button.parentElement.remove()))
const refresh = Number(document.body.dataset.autorefresh)
if (refresh > 0)
  setInterval(() => {
    if (
      !document.hidden &&
      !document.querySelector('[role="dialog"]:not([hidden])') &&
      document.body.dataset.refreshPaused !== 'true'
    )
      location.reload()
  }, refresh * 1000)
