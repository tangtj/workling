export function LoginPage() {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>登录 · workling</title>
        <link rel="stylesheet" href="/style.css" />
        <script src="/login.js" defer></script>
      </head>
      <body data-page="login" class="login">
        <div class="login-inner">
          <div class="brand">
            <span class="brand-mark">P</span>
            <span>
              workling<small>本机管理</small>
            </span>
          </div>
          <form id="login-form" class="card stack">
            <div>
              <h1>登录</h1>
              <p class="muted">首次启动 watch 时，控制台会打印管理密码。</p>
            </div>
            <div id="login-error" class="error-box" role="alert" hidden></div>
            <label>
              密码
              <input
                id="password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
              />
            </label>
            <button class="button button--primary" type="submit">
              登录
            </button>
          </form>
          <p class="muted">
            忘记密码？在终端运行
            <br />
            <code>bun src/cli.ts reset-password</code>
            <br />
            生成新密码，已登录的会话会失效。
          </p>
        </div>
      </body>
    </html>
  )
}
