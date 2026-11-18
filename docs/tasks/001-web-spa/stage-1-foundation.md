# 阶段 1：React 底座与片段模式

> 入口文档见 [README.md](README.md)。本阶段完成后，站内点击不再整页刷新；所有页面的内容和行为与迁移前一致。

## 1. 依赖与 TypeScript

- 新增依赖（`dependencies`）：`react`、`react-dom`、`react-router`、`@tanstack/react-query`；开发依赖：`@types/react`、`@types/react-dom`。
- 客户端代码放 `src/web/client/`。根 `tsconfig.json` 的 `jsxImportSource` 仍是 `hono/jsx`（旧视图要用），所以：
  - 新增 `src/web/client/tsconfig.json`：`extends` 根配置，`jsxImportSource` 改为 `react`，`lib` 加上 `DOM`、`DOM.Iterable`，`types` 不含 `bun`，`include` 只有本目录。
  - 根 `tsconfig.json` 的 `exclude` 加上 `src/web/client`。
  - `check` 脚本在 `tsc --noEmit` 后追加 `tsc --noEmit -p src/web/client`。
- Bun 打包时按最近的 tsconfig 决定 JSX 运行时，无需额外配置；实现后用一次打包结果确认没有混入 `hono/jsx`。

## 2. 打包与资源路由

新增 `src/web/bundle.ts`：

```ts
export type WebBundle = {
  // 发布路径（如 /assets/main-3f2a1c.js）到内容与 Content-Type
  files: Map<string, { body: Uint8Array; type: string }>
  script: string // 入口 JS 的发布路径
  styles: string[] // 入口 CSS 的发布路径
}
export async function buildWebBundle(): Promise<WebBundle>
```

- 用 `Bun.build({ entrypoints: [<client/main.tsx>], target: 'browser', minify: true, naming: '[name]-[hash].[ext]', splitting: false })`，不传 `outdir`，从返回的 artifacts 读出内容；`success` 为 false 时把 `logs` 拼进错误抛出。
- 只在 `createApp` 首次需要时构建一次并缓存 Promise（`serve` 启动时主动触发一次，构建失败则启动失败并打印错误）。测试里也走同一个函数。
- 新增路由 `GET /assets/:name`：命中 `files` 时返回内容，响应头为 `webHeaders` 去掉 `Cache-Control` 后加上 `Cache-Control: public, max-age=31536000, immutable`；未命中返回 404。鉴权：`/assets/*` 加入公共路由（登录页之后也会用到，且内容不含数据）。
- 旧的 `/style.css`、`/app.js`、`/version.js`、`/timeline.js`、`/run-log.js`、`/login.js` 路由保留（登录页与片段仍在用），阶段 0 为它们加的版本参数与缓存头保持不变；阶段 0 对 `color-scheme` 与主题脚本的处理同样保留。

## 3. SPA 外壳

页面路由 `/`、`/issues`、`/issues/:id`、`/repos`、`/repos/:id`、`/settings`、`/runs/:id/log`：

- **普通请求**（无 `X-Workling-Fragment` 请求头）：返回外壳 HTML，状态码与现在相同（找不到的 Issue / 仓库 / 执行记录仍返回 404，外壳由前端显示不存在页面）。外壳内容：

  ```html
  <!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <title>Workling</title>
      <script>
        {
          themeScript
        }
      </script>
      <link rel="stylesheet" href="{styles[i]}" />
      <script type="module" src="{script}"></script>
    </head>
    <body>
      <div id="root"></div>
    </body>
  </html>
  ```

  外壳由一个函数生成，`Cache-Control: no-store` 保持不变。`themeScript` 来自 `src/web/views/theme.ts`，原样内联（CSP 按其哈希放行，内容一改哈希自动跟着变）。

- **片段请求**（`X-Workling-Fragment: 1`）：返回现有页面组件（`OverviewPage`、`IssuesPage` 等）渲染出的 HTML，不套 `Layout`。响应头额外带：
  - `X-Workling-Title`：页面标题，`encodeURIComponent` 编码（如 `概览`）；
  - `X-Workling-Active`：侧栏高亮项（`overview` / `issues` / `repos` / `settings` / 空）；
  - `X-Workling-Refresh`：需要自动刷新时为秒数（目前只有概览，`15`）。
  - 状态码与普通请求一致，404 时内容为 `NotFoundPage`。
- 不在上述列表中的 GET 路径保持现状（404 走现有逻辑）；`/login` 本阶段仍是 SSR 页面。

## 4. 侧栏数据接口

新增 `GET /api/shell`，返回侧栏需要的数据（取自 `pageData`，不返回 token）：

```ts
{
  version: string
  repos: { id: number; ref: string; enabled: boolean; open: number }[] // open = queued+running+failed 的 Issue 数
  failed: number
  running: number
  concurrency: number
  watch: null | {
    worker: string
    interval: number
    lastPollAt: string | null // ISO
    lastPollError: string | null
  }
  now: string // ISO，前端据此计算"上次轮询 N 秒前"
}
```

前端每 15 秒、每次站内导航后、每次写操作成功后重取。

## 5. React 外壳（`src/web/client/`）

- `main.tsx`：`import '../assets/style.css'`；创建 `QueryClient` 与 `createBrowserRouter`，挂载到 `#root`。
- `Layout`：按 `src/web/views/layout.tsx` 的结构与 class 名 1:1 重写侧栏（品牌、导航、已启用仓库、watch 卡片、主题切换、退出登录），保证样式不变。导航与仓库链接用 React Router 的 `<Link>`。主题切换按钮在 React 中实现，行为与 `app.js` 现有逻辑一致（`localStorage` 键 `workling-theme`，跟随系统 → 浅色 → 深色循环，同步 `<html data-theme>`），`app.js` 中对应代码删除。版本胶囊的 DOM 照抄现有侧栏；弹层 `VersionPopover` 的 DOM（id、class、属性）照抄，和现在一样渲染在 `.shell` 之外（避免被侧栏截断）。挂载后调用 `version.js` 导出的初始化函数（见第 6 节），本阶段不重写版本面板。
- 路由：上述 7 个页面路径都映射到同一个 `LegacyPage` 组件；其余路径显示与 `NotFoundPage` 相同的内容。
- `LegacyPage`：
  1. 以当前 `pathname + search` 发起 `fetch(url, { headers: { 'X-Workling-Fragment': '1' } })`；用 TanStack Query 缓存，key 为 URL；
  2. 401 → `location.assign('/login')`；其他非 2xx 但带 HTML 的（如 404）照常显示；网络错误显示错误提示和"重试"按钮；
  3. 写入 `<main class="main">` 的容器（`dangerouslySetInnerHTML`），设置 `document.title = \`${title} · Workling\``，更新侧栏高亮；
  4. 内容插入后调用旧脚本的 `init(container, ctx)`，组件卸载或内容替换前调用其返回的 `destroy`；
  5. `X-Workling-Refresh` 有值时按该间隔重取片段（页面隐藏、有打开的 `dialog`、或 `body.dataset.refreshPaused === 'true'` 时跳过，与现有逻辑一致）；
  6. URL 带 `#hash` 时，插入后滚动到对应元素；否则新导航滚动到顶部，后退时恢复滚动位置（React Router 的 `<ScrollRestoration />`）。
- 片段中的站内链接：在容器上委托 `click`，对同源、非 `target=_blank`、无修饰键、`href` 以 `/` 开头且不以 `/api/` 开头的 `<a>`，`preventDefault` 后调用 `navigate(href)`。

## 6. 旧脚本改为可重复初始化

旧脚本现在在加载时直接 `querySelectorAll` 绑定事件，要改成可以对同一页面反复初始化和清理：

- `app.js` 改为 ES module，导出：

  ```js
  export function init(root, ctx) // 返回 destroy()
  // ctx = { navigate(url), refresh() }
  ```

  - 所有 `document.querySelector*` 改为 `root.querySelector*`（退出登录按钮除外，它移到 React 侧栏里实现）。
  - 写操作成功后的 `location.assign(url)` 全部改为 `ctx.navigate(url)`；之后的阶段再去掉 `?notice=` 这种传参方式。
  - `window` 上的 `hashchange` 监听与自动刷新 `setInterval` 移除（自动刷新由 `LegacyPage` 负责）；`#add` 打开对话框的逻辑在 `init` 时检查一次即可，`destroy` 里关闭仍打开的 `dialog`。
  - 401 仍然 `location.assign('/login')`。

- `run-log.js` 改为导出 `init(root)`，返回的 `destroy` 清掉内部的 `setInterval` 与进行中的 `fetch`（用 `AbortController`）；不再在模块顶层自动执行。它对 `/timeline.js` 的导入不变。
- `version.js` 改为导出 `init()`，返回 `destroy`（移除 `document` 上的两个监听）。
- 外壳通过动态 `import('/app.js')` 等方式加载这些旧脚本（它们不进 React 打包，避免同一份代码两套），并在 `LegacyPage` 中根据片段里是否有时间线元素决定是否初始化 `run-log.js`。
- 旧视图里的 `<script>` 标签（`run-log.tsx`、`issue.tsx` 中的 `run-log.js`）删除，片段不再自带脚本。
- 登录页不受影响：`login.js` 不动。

## 7. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过（含 `tsc --noEmit -p src/web/client`）。
- [ ] 测试：七个页面路由普通请求返回外壳（含带哈希的 `/assets/*.js` 与 `.css`），片段请求返回不含 `<html>` 的内容及三个响应头；不存在的 Issue / 仓库 / 执行记录两种请求都返回 404；`/assets/<不存在>` 返回 404；`/assets/*` 响应头含 `immutable` 且仍有 CSP；`/api/shell` 字段与类型正确、不含 token；未登录访问外壳跳转 `/login`、访问 `/api/shell` 返回 401。
- [ ] 测试：`buildWebBundle()` 成功，产物 JS 中不含 `hono/jsx`。
- [ ] 手动（`bun run dev`）：侧栏导航、仓库快捷链接、片段内链接切换时不整页刷新（Network 面板无 document 请求）；前进 / 后退、刷新、直接打开深链接都正常；概览每 15 秒更新；仓库增删启停、换 token、设置保存、Issue 筛选、复制按钮、执行日志实时时间线都和迁移前一样工作；修改密码可用；版本面板可打开、检查更新，弹层不被侧栏截断；主题切换三态循环且刷新后保持；退出登录跳转登录页；控制台无 CSP 报错；深色模式切页不闪白。

## 8. 不做

- 不把任何页面改成 React 组件（侧栏除外），不改视觉与文案。
- 不改登录页、版本面板逻辑和现有 `/api/*` 接口。
- 不引入 SSR、代码分割、HMR、UI 组件库或 CSS 方案替换。
