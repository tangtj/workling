import '../assets/style.css'
import { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { cliCommand } from './deploy.ts'

function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showReset, setShowReset] = useState(false)
  // 点浮层以外的地方即关闭，不必再点一次链接
  useEffect(() => {
    if (!showReset) return
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.forgot'))
        setShowReset(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [showReset])
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
        <span>Workling</span>
      </div>
      <form id="login-form" className="card stack" onSubmit={submit}>
        <h1>登录</h1>
        <div id="login-error" className="error-box" role="alert" hidden={!error}>
          {error}
        </div>
        <label>
          管理密码
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
        <div className="forgot" onMouseLeave={() => setShowReset(false)}>
          <button
            type="button"
            className="link-button"
            aria-expanded={showReset}
            aria-controls="forgot-tip"
            onClick={() => setShowReset((open) => !open)}
            onKeyDown={(event) => event.key === 'Escape' && setShowReset(false)}
          >
            忘记密码？
          </button>
          {showReset && (
            <div id="forgot-tip" className="forgot-tip" role="status">
              运行 <code>{cliCommand('reset-password')}</code> 重置
              <br />
              已登录的会话会失效
            </div>
          )}
        </div>
        <button className="button button--primary" type="submit" disabled={submitting}>
          登录
        </button>
      </form>
    </div>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少应用挂载点')
createRoot(root).render(<Login />)
