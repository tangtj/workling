# 阶段 5：设置页

> 入口文档见 [README.md](README.md)。本阶段把设置页 `/settings` 换成 React 组件。各卡片独立保存、独立显示未保存状态：保存一张卡片后页面不重载，其他卡片里尚未保存的修改保留。除第 4 节注明的保存反馈外，内容、样式和交互与迁移前一致。

## 1. 范围

- `/settings`：页头、左侧分区导航、Codex、Pi 与 LLM 接入、提交身份、执行器、管理密码、启动参数（只读）、状态标签与运维命令。
- 现有实现：`src/web/views/settings.tsx`（片段模式）加 `src/web/assets/app.js` 中 `form[data-settings]`、`#password-form`、`[data-clear-key]`、`[data-copy]`、`[data-dismiss]` 的处理。保存成功后现在会跳转 `/settings?notice=saved#<分区>` 整页重载，**其他卡片未保存的修改会丢失**，这是本阶段要解决的问题。
- 写接口沿用 `PATCH /api/settings/pi`、`PATCH /api/settings/executor`、`POST /api/password`，行为不变。

## 2. 数据接口

新增 `GET /api/settings`，一次返回页面需要的全部数据。schema 用 typebox 定义在 `src/web/settings.ts`（对象一律 `additionalProperties: false`）：

```ts
{
  pi: ResponsePi // 与 GET /api/settings/pi 相同：responsePi(readPiSettings(db))，llmApiKey 已打码
  executor: ExecutorSettings // 与 GET /api/settings/executor 相同
  startup: {
    workspace: string
    worker: string
    host: string
    port: number
    allowedHosts: string[]
    secureCookie: boolean
  } | null // options.startup 未提供时为 null
  labels: { name: string; description: string }[] // WORKLING_LABELS
}
```

- 返回前 `Value.Check`，`Cache-Control: no-store`。不返回 LLM Key 原文。
- 客户端不直接引用 `src/serve/poll.ts`（会把服务端代码打进前端包），标签列表只从接口取。

## 3. 卡片状态

客户端新增：

```text
src/web/client/settings.ts         ['settings'] 取数与校验；各卡片的字段映射（见下表）
src/web/client/pages/settings.tsx  /settings
```

| 卡片      | 字段                                                                                       | 保存接口                       | 请求体映射（与 `app.js` 现有逻辑一致）                                    |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| Codex     | `model`、`effort`                                                                          | `PATCH /api/settings/pi`       | 原样                                                                      |
| Pi 与 LLM | `piModel`、`llmApi`、`llmBaseUrl`、`llmApiKey`                                             | `PATCH /api/settings/pi`       | `piModel`、`llmBaseUrl` 空串转 `null`；`llmApiKey` 为空串时不放进请求体   |
| 提交身份  | `gitName`、`gitEmail`                                                                      | `PATCH /api/settings/pi`       | 原样                                                                      |
| 执行器    | `sandbox`、`concurrency`、`taskImage`、`taskCpus`、`taskMemory`、`taskPids`、`taskNetwork` | `PATCH /api/settings/executor` | `concurrency`、`taskCpus`、`taskPids` 转数字；`taskNetwork` 空串转 `null` |

- 每张卡片有自己的**基线**（来自服务端的值）和**草稿**（受控表单）。草稿与基线不同即为"有未保存的修改"：卡片底部 `.card-foot` 加 `dirty` class，说明文字换成"有未保存的修改"，与现在一致。`llmApiKey` 输入框非空也算修改。
- **撤销**：草稿恢复为基线，清除错误。
- **保存**：只提交本卡片的字段。成功后用响应更新 `['settings']` 缓存中对应的 `pi` 或 `executor`；**草稿与基线相同（未修改）的卡片随新数据同步，有未保存修改的卡片保留草稿不动**。三张 Pi 卡片共用 `pi` 数据，这条规则对它们同样适用。保存请求期间该卡片的保存按钮禁用。
- **失败**：错误文案显示在本卡片的 `.error-box[role="alert"]`，草稿保留。
- **清除 Key**：`confirm('确认清除 LLM Key？')` 后 `PATCH /api/settings/pi { llmApiKey: null }`，成功后同"保存"处理，失败显示在 Pi 卡片的错误框。
- **执行器卡片**：`.opt.on` 跟随当前选中的 `sandbox`；选"本机进程"时 Docker 参数区加 `muted-fieldset`，与现在一致。
- **管理密码**：两次新密码不一致时在卡片内报错、不发请求；成功或失败后都清空三个输入框（与现在一致）。成功后其他会话已失效，本会话继续可用。

## 4. 保存反馈

- 不再跳转、不再写 `?notice=`。保存成功后，在页面顶部显示与现在相同的 `.notice[role="status"]`（"设置已保存" / "密码已修改，其他会话已退出"），带"关闭"按钮；同时被保存的卡片底部说明文字显示"已保存"，直到该卡片再次被修改。这是本阶段唯一的可见变化。
- 页面停留在原位置，不滚动、不丢焦点。

## 5. 其他

- 分区导航仍是页内锚点（`#set-codex` 等），点击后滚动到对应卡片；直接打开 `/settings#set-pi` 时，数据加载完成后滚动到该卡片。注意 React Router 处理纯锚点链接时不能触发重新取数或回到顶部。
- 启动参数、状态标签、运维命令三块只读内容与现在一致；"复制"按钮写剪贴板后显示"已复制"，2 秒后恢复。
- 旧地址上的 `?notice=` 参数忽略。
- 页面标题 `设置 · Workling`，侧栏高亮 `settings`。
- 路由：`/settings` 从 `LegacyPage` 列表移出，loader 预取 `['settings']`。保存设置后让 `shellKey` 失效（侧栏显示并发上限）。

## 6. 服务端与旧代码清理

- `src/web/routes/pages.ts`：`/settings` 的普通请求和片段请求都返回外壳。
- 删除 `src/web/views/settings.tsx`。
- `src/web/assets/app.js` 删除 `form[data-settings]`、`#password-form`、`[data-clear-key]` 的处理；`[data-copy]`、`[data-dismiss]`、`[data-open]`、`[data-close]` 确认已无旧页面使用后删除（Issue 详情页在阶段 6 之前仍用 `[data-copy]`）。

## 7. 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] 测试：`GET /api/settings` 通过 schema 校验，不含 LLM Key 原文；未登录返回 401；`startup` 未提供时为 `null`。
- [ ] 测试：`/settings` 的普通请求和片段请求都返回外壳。
- [ ] 测试：把"卡片草稿 → 请求体"的映射和"保存后哪些卡片同步、哪些保留草稿"的判断写成纯函数，用表驱动用例覆盖（空串转 `null`、空 Key 不提交、数字转换、有修改的卡片不被覆盖）。
- [ ] 手动（`bun run dev`）：与迁移前逐项对比外观；同时修改 Codex 与提交身份两张卡片，只保存 Codex，提交身份的修改仍在且显示"有未保存的修改"；保存失败（如 docker 沙箱未配 LLM 地址）时错误显示在对应卡片且草稿保留；撤销恢复为已保存的值；清除 Key、修改密码正常；锚点导航与 `/settings#set-pi` 深链接正常；控制台没有 CSP 报错。

## 8. 不做

- 不改设置接口的行为和字段，不新增设置项（002 的允许名单等设置项在本阶段合入后另行添加）。
- 不做离开页面时的未保存提醒。
- 不迁移 Issue 详情、执行日志页面。
