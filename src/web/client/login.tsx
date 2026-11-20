import '../assets/style.css'
import { useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'

function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = password
    setPassword('')
    setError('')
    setSubmitting(true)
    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: value }),
      })
      if (!response.ok) throw new Error((await response.json()).error || '登录失败')
      location.assign('/')
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="login-inner">
      <div className="brand">
        <span className="brand-mark">W</span>
        <span>
          Workling<small>本机管理</small>
        </span>
      </div>
      <form id="login-form" className="card stack" onSubmit={submit}>
        <div>
          <h1>登录</h1>
          <p className="muted">首次启动 watch 时，控制台会打印管理密码。</p>
        </div>
        <div id="login-error" className="error-box" role="alert" hidden={!error}>
          {error}
        </div>
        <label>
          密码
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="button button--primary" type="submit" disabled={submitting}>
          登录
        </button>
      </form>
      <p className="muted">
        忘记密码？在终端运行
        <br />
        <code>bun src/cli.ts reset-password</code>
        <br />
        生成新密码，已登录的会话会失效。
      </p>
    </div>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少应用挂载点')
createRoot(root).render(<Login />)
