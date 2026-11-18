# 阶段 7：收尾

> 入口文档见 [README.md](README.md)。阶段 1–6 完成后，所有业务页面都已是 React。本阶段把剩下的版本面板和登录页改为 React，删除片段模式、Hono JSX 视图和全部旧脚本，结束迁移。页面的内容、样式和交互与迁移前一致。

## 1. 前提

阶段 6 已合入：`main.tsx` 中已没有路由映射到 `LegacyPage`。开始前先确认这一点，不满足就停下来在 PR 里说明，不要在本阶段补迁页面。

## 2. 版本面板

- 把 `src/web/assets/version.js` 的逻辑搬进 React：新增 `src/web/client/version-panel.tsx`，替换 `layout.tsx` 里现在的 `VersionPopover` 静态结构和 `loadVersion()` 调用。
- 行为逐项保持一致：打开 / 关闭弹层；检查更新；展示当前版本、新版本说明与"展开更多"；发起更新、等待运行中的任务、取消、立即更新；轮询更新任务状态；更新后等待服务重启并刷新页面；各请求的超时（`version?local=1` 与 `job` 为 5 秒，其余 35 秒）；401 跳转 `/login`。
- DOM 结构与 class 名保持现状（`version-pill`、`version-popover`、`version-head`、`version-body`、`version-badge`、`version-notes` 等）。现有的 `id` 只为旧脚本查找元素服务，React 不依赖它们时可以删除，但 `aria-controls` 关联要保留。
- **暂停自动刷新**：现在通过 `document.body.dataset.refreshPaused` 通知概览页暂停轮询。改为新增 `src/web/client/refresh-pause.ts`（模块级状态 + `useSyncExternalStore`），版本面板写入，概览页轮询读取。删除对 `dataset.refreshPaused` 的读写。

## 3. 登录页

- 新增 `src/web/client/login.tsx` 作为**第二个打包入口**：`src/web/bundle.ts` 的 `Bun.build` 增加该入口，`WebBundle` 增加 `loginScript`（以及登录页需要的样式）。产物仍在 `/assets/` 下，本来就对未登录请求开放。
- `GET /login` 返回一个精简外壳：`<html lang="zh-CN">`、与现在相同的 `<head>`（charset、viewport、标题 `登录 · Workling`、`color-scheme`、首屏主题脚本、样式），`<body data-page="login" class="login">` 内放挂载点，加载 `loginScript`。
- 登录组件的 DOM、文案与 `src/web/views/login.tsx` 一致；提交逻辑与 `login.js` 一致：提交时清空密码框、按钮禁用、失败显示服务端错误、成功 `location.assign('/')`。
- `src/web/app.ts` 的公开路由去掉 `/login.js` 和 `/style.css`（样式改由打包产物提供后不再需要）。

## 4. 删除旧机制

- **片段模式**：删除 `src/web/routes/pages.ts` 中的 `render()`、`X-Workling-Fragment` / `X-Workling-Title` / `X-Workling-Active` / `X-Workling-Refresh` 响应头与 `Vary`；所有页面路由直接返回外壳（保留现有的 404 判断）。删除 `app.ts` 认证中间件中对 `X-Workling-Fragment` 的特殊处理。
- **客户端**：删除 `src/web/client/legacy-page.tsx`；`legacy.ts` 中仍在使用的 `readResponse`、`Active` 移到 `src/web/client/http.ts`（或同类命名），其余删除。`bundle.ts` 删除 `external` 列表。
- **旧脚本**：删除 `src/web/assets/app.js`、`version.js`、`login.js`，以及 `src/web/assets.ts`、`src/web/routes/assets.ts` 中提供这些脚本和 `/style.css` 的部分。`style.css` 保留在原位置，由客户端入口 `import`。`src/web/text-modules.d.ts` 中不再需要的声明删除。
- **Hono JSX 视图**：删除 `src/web/views/` 目录。仍在使用的部分迁出：`theme.ts` → `src/web/theme.ts`；`format.ts` → `src/web/format.ts`（同时修改客户端的引用）；`shell.tsx` 改为 `src/web/shell-html.ts`，用模板字符串生成外壳 HTML（文本插值必须转义）。确认 `hono/jsx` 已无引用后，调整 `tsconfig` 中只为它服务的 JSX 配置。
- 相关测试（`test/legacy-ui.test.ts`、`test/version-ui.test.ts`、`test/theme-ui.test.ts`、`test/web.test.ts` 等）随之更新或删除：只验证旧脚本的用例删除，验证行为的用例改为针对新实现。

## 5. 文档

- `AGENTS.md` 删除"Web 界面迁移方向"一节。
- `docs/tasks/001-web-spa/README.md` 顶部状态改为"已完成"，第 5 节表格保留作为记录。
- `README.md`、`README.zh-CN.md` 中如有提到旧脚本或片段模式的内容，同步修改。

## 6. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] `src/web/views/`、`src/web/assets/*.js`、`legacy-page.tsx` 已不存在；`rg "X-Workling-Fragment|refreshPaused|hono/jsx" src` 无结果。
- [ ] 测试：`GET /login` 未登录时返回登录外壳，引用的脚本和样式未登录也能取到；已登录时跳转 `/`；登录成功与失败的接口测试保持通过。
- [ ] 测试：任意页面路由（含片段请求头）都返回外壳；不存在的路径状态码与迁移前一致。
- [ ] 测试：CSP 头与迁移前完全相同；外壳与登录页中除首屏主题脚本外没有内联脚本和内联 `<style>`。
- [ ] 手动（`bun run dev`）：登录、退出、会话过期跳转正常；版本面板检查更新、展开说明、发起与取消更新（可用测试仓库或接口替身）正常，更新期间概览页暂停轮询；所有页面站内跳转、前进后退、刷新、深链接正常；控制台没有 CSP 报错；深色模式下切换页面不闪白。

## 7. 不做

- 不改任何页面的视觉、文案和接口。
- 不改 `/api/system/*` 更新接口的行为。
- 不调整 `style.css` 的组织方式（拆分、CSS Modules 等另议）。
