const form = document.querySelector('#login-form')
const errorBox = document.querySelector('#login-error')
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = form.elements.password.value
  form.elements.password.value = ''
  const submit = form.querySelector('button[type="submit"]')
  submit.disabled = true
  errorBox.hidden = true
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!response.ok) throw new Error((await response.json()).error || '登录失败')
    location.assign('/')
  } catch (error) {
    errorBox.textContent = error.message
    errorBox.hidden = false
  } finally {
    submit.disabled = false
  }
})
