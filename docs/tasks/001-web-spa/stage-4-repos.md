# 阶段 4：仓库页

> 入口文档见 [README.md](README.md)。本阶段把仓库页 `/repos` 换成 React 组件。增删、启停、换 token 改为调用现有 JSON 接口后让相关查询失效重取，不再跳转到带 `?notice=` 的地址整页重载。页面的内容、样式和交互与迁移前一致。

## 1. 范围

- `/repos`：页头、提示条、仓库卡片（启停开关、四个状态计数、更新时间、更换 token、删除）、无仓库时的引导卡片、添加仓库抽屉（`<dialog class="drawer">`）、底部"暂只支持 GitHub"说明。
- 现有实现：`src/web/views/repos.tsx`（片段模式）加 `src/web/assets/app.js` 中仓库相关的事件处理。
- 接口沿用 `src/web/routes/repos.ts` 的 `GET/POST /api/repos`、`PATCH/DELETE /api/repos/:id`，**行为不变**。

## 2. 数据

- 仓库卡片的数据来自 `GET /api/repos`（查询 key `['repos']`）。新增 `src/web/repos.ts`，用 typebox 定义该接口单个仓库的返回形状 `repoSchema`（字段即 `responseRepo` 的输出：`id`、`ref`、`platform`、`host`、`path`、`token`（已打码）、`enabled`、`createdAt`、`updatedAt`，`additionalProperties: false`）。服务端返回前用 `Value.Check` 校验数组；客户端取数后同样校验，再把时间转成 `Date`。`token` 字段名不改，客户端只把它当作打码后的展示值。
- 四个状态计数来自阶段 2 的 `['issue-list']` 查询，按 `repoId` 计数，与现在 `count(...)` 的结果一致。两个查询并行加载，任一失败都显示"加载页面失败 + 重试"。
- 仓库为空时显示引导卡片，与现在一致。

## 3. 页面

客户端新增：

```text
src/web/client/repos.ts        ['repos'] 取数与校验；请求封装：成功返回 JSON，失败抛出带服务端 error 文案的 Error，401 跳转 /login（复用 readResponse）
src/web/client/pages/repos.tsx /repos
```

- **DOM 与 class 名和现有视图 1:1 一致**（`page-head`、`notice`、`repo-cards`、`card repo`、`off`、`repo-top`、`repo-name`、`switch`、`counts`、`repo-foot`、`link-button`、`danger`、`token-form`、`drawer`、`drawer-head`、`drawer-body`、`drawer-foot`、`perm`、`steps` 等），文案不变。
- **写操作**一律用 TanStack Query 的 `useMutation`。成功后让 `['repos']`、`['issue-list']`、`['overview']` 和侧栏的 `shellKey` 失效重取，然后在页面顶部显示与现在相同文案的 `.notice`（已添加仓库 / 已删除仓库 / 已更换 token / 已启用 / 已停用），带"关闭"按钮。提示只存在组件状态里，不写进 URL。
  - **启停开关**：请求期间按钮禁用；失败时 `alert(错误文案)`，与现在一致。`aria-checked` 以重取后的数据为准，不做乐观更新。
  - **更换 token**：每张卡片各自展开 / 收起表单（组件状态）；失败时错误文案显示在表单内的 `role="alert"` 里；成功后收起表单并清空输入。
  - **删除**：沿用 `prompt('输入 <ref> 确认删除；该仓库的 Issue 记录会一并删除')`，输入不一致就不发请求；失败时 `alert`。
  - **添加**：抽屉用 `ref` 调 `showModal()` / `close()`。失败时错误显示在 `#add-error` 位置的 `.error-box`；成功后关闭抽屉并重置表单。
- 地址带 `#add` 时（概览页"添加仓库"按钮跳转到 `/repos#add`）进入页面后自动打开抽屉，与现在一致；站内导航到同一地址也要生效。
- 旧地址上的 `?notice=` 参数忽略，不报错。
- 页面标题 `仓库 · Workling`，侧栏高亮 `repos`。
- 路由：`src/web/client/main.tsx` 中 `/repos` 从 `LegacyPage` 列表移出，loader 预取 `['repos']` 与 `['issue-list']`。

## 4. 服务端与旧代码清理

- `src/web/routes/pages.ts`：`/repos` 的普通请求和片段请求都返回外壳。
- 删除 `src/web/views/repos.tsx`。
- `src/web/assets/app.js` 删除仓库相关的处理：启停开关、`[data-token-toggle]`、`.token-form`、`[data-delete]`、`#add-form`、`#add` 自动打开抽屉。`[data-open]`、`[data-close]`、`[data-dismiss]`、`[data-copy]` 如果其他旧页面（设置、Issue 详情）还在用就保留，确认无人使用才删。
- `shared.tsx` 中只被仓库页使用的导出一并删除。

## 5. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] 测试：`GET /api/repos` 的返回通过 `repoSchema` 校验，不含 token 原文；现有 `POST/PATCH/DELETE` 的测试保持通过。
- [ ] 测试：`/repos` 的普通请求和片段请求都返回外壳。
- [ ] 手动（`bun run dev`）：与迁移前逐项对比外观；添加（成功、仓库已存在、引用无效）、启停、换 token（成功、空 token）、删除（确认、取消）后，页面不整页刷新，提示文案正确，侧栏仓库列表和计数同步更新；从概览点"添加仓库"会直接打开抽屉；浏览器前进 / 后退不会重放写操作；控制台没有 CSP 报错。

## 6. 不做

- 不改 `/api/repos` 系列接口的行为和返回字段，不加 GitLab 支持。
- 不把 `prompt` / `alert` 换成自定义对话框（不改交互）。
- 不迁移设置、Issue 详情、执行日志页面。
