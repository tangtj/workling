# 阶段 2：分诊页 `/triage`

> 入口文档见 [README.md](README.md)。前置：阶段 1 已合入。

## 1. 目标

- 分诊升为一级导航，在一个页面里看所有仓库的分诊级别、机器与人工的对照、建议的效果和分诊记录。
- 把分诊计算从路由里抽成函数，供本页和阶段 3 的概览复用。
- 仓库详情页的分诊卡片缩成摘要，详细内容链到 `/triage?repo=<id>`。

## 2. 抽出计算

`src/web/routes/repos.ts` 中 `GET /api/repos/:id/triage` 现有的计算（`followUp`、`suggestions`、`records`、`summary`）原样搬到 `src/web/triage.ts`：

```ts
export function repoTriage(db: WorklingDatabase, repo: Repo): TriageData // 即现有 triageSchema 的形状
```

- 行为保持不变，`GET /api/repos/:id/triage` 改为调用它，响应逐字段不变（现有测试应原样通过）。
- 顺手消除逐条 `select issues` 查询：先一次查出该仓库所有 Issue，按 `number` 建 Map 再取。

## 3. 新接口 `GET /api/triage`

在 `src/web/triage.ts` 新增 schema `triageOverviewSchema` 并校验响应：

```ts
{
  repos: Array<{
    id: number
    ref: string
    platform: 'github' | 'gitlab'
    host: string
    path: string
    enabled: boolean
    level: 'off' | 'shadow' | 'suggest' | 'auto'
    summary: TriageData['summary']
  }>
  summary: TriageData['summary'] // 所有仓库逐字段相加
  records: Array<TriageData['records'][number] & { repoRef: string }>
  // 所有仓库的 records 合并，按 triagedAt 倒序，最多 200 条
  pendingSuggestions: number // records 中 followUp === 'pending' 的条数
}
```

只包含 `enabled` 或 `level !== 'off'` 的仓库。

`GET /api/shell` 增加 `triagePending: integer`，取值同 `pendingSuggestions`。

## 4. 页面

新增 `src/web/client/pages/triage.tsx`，路由 `/triage`（`main.tsx` 加 loader 预取，`routes/pages.ts` 加返回外壳的页面路由，与 `/issues` 相同写法）。`document.title` 为「分诊 · Workling」，侧栏高亮「分诊」。

页面自上而下：

1. **标题区**：「分诊」+ 一句说明：「新 Issue 先由 LLM 判断能否开工；影子级只记录，与人工是否打 ready 对照，数据靠得住再逐个仓库放开。」LLM 未配置时（读 `/api/settings` 的 `pi.llmBaseUrl` / `pi.llmApiKey`，与仓库详情现有判断相同）显示提示，链接到设置页。
2. **各仓库级别**（卡片 + 表格）：列为 仓库（等宽 ref，链接 `/repos/:id`）· 级别 · 一致率 · 样本。
   - 级别用四段按钮组（关闭 / 影子 / 建议 / 自动），当前级别高亮；按钮组用 `role="group"` 和 `aria-label="<ref> 分诊级别"`。点击调用现有 `PUT /api/repos/:id/triage-level`，切到「建议」「自动」前沿用仓库详情现有的 `confirm` 文案；成功后失效 `/api/triage` 与该仓库的分诊查询。非 GitHub 仓库按钮组禁用并显示「暂只支持 GitHub」。
   - 一致率 = `(acceptReady + otherNotReady) / total`，取整百分比；`total` 为 0 显示「—」。样本 = `total`。
3. **两张并排卡片**（宽度不足时上下排列）：
   - **机器结论 × 人工动作**：2×2 表。行：机器 accept / 机器其他；列：人工打了 ready / 人工没打 ready。四格分别是 `acceptReady`、`acceptNotReady`、`otherReady`、`otherNotReady`。对角线两格（一致）用 `--done-soft` 底色，另两格（不一致）用 `--failed-soft` 底色，格内写数字和「一致」/「机器放宽了」/「机器卡严了」。表下一行写「一致率 = x / total = y%」。数据来自顶层 `summary`。
   - **建议的效果**：三个数字：已评论建议 `suggestions.total`、作者补充了 `suggestions.edited`、未改直接 ready `suggestions.readyWithoutEdit`；下面一行「被跳过的比例 z%，N 条仍在等作者」（N = `suggestions.pending`）。
4. **分诊记录**（卡片 + 表格）：
   - 筛选按钮：全部 · 只看不一致 · 等作者补充，各带数量。「不一致」= `decision === 'accept'` 且 `readyAt` 为空，或 `decision` 为 `needs_info` / `ignore` 且 `readyAt` 不为空；`alreadyReady` 为真的记录不算不一致。「等作者补充」= `followUp === 'pending'`。
   - 仓库筛选：URL `?repo=<id>`，下拉框选仓库，默认全部。
   - 列：Issue（`repoRef#number` 等宽 + 标题，链接到 GitHub）· 作者（login + 信任来源「写权限」/「受信账号」）· 机器结论（徽章：accept 用 `badge--done`，needs_info 用 `--warn` 色，ignore 用 `badge--queued`；`llmDecision` 与 `decision` 不同时下方小字「LLM：xxx」；无结论显示「无结论」与 `error`）· 缺少（`missing` 用顿号连接，空为「—」）· 人工（`readyAt` 有值显示「ready」并附 `readyAfterMinutes` 分钟，否则「未 ready」；`autoQueuedAt` 有值显示「自动 ready」）· 跟进（有 `suggestCommentUrl` 时链接「已评论」，再接 `followUp` 中文：已补充 / 未改直接 ready / 等作者）· 分诊时间（相对时间）。
   - 不一致的行加浅色底（`--failed-soft`）。`note`、`error`、`suggestError` 任一非空时，行尾有「说明」按钮展开一行显示。
   - 没有记录时显示「暂无分诊记录」。

## 5. 侧栏与仓库详情

- `layout.tsx` 导航在「任务」和「仓库」之间加「分诊」（漏斗图标：`M4 5h16l-6 7v6l-4 2v-8z`，描边风格与其他图标一致），`triagePending > 0` 时显示「N 待补充」徽章（`--warn` 色）。`Active` 类型增加 `'triage'`。
- `src/web/client/pages/repo.tsx` 的 `Triage` 组件改为摘要卡片：标题「分诊」、当前级别（同第 4 节的四段按钮组，可直接切换）、一致率与样本数、链接「查看分诊记录」到 `/triage?repo=<id>`。删除卡片里的两行文字统计和记录列表。受信账号卡片不改。

## 6. 验收

- [ ] `GET /api/repos/:id/triage` 响应与改动前逐字段一致，原有测试通过。
- [ ] `GET /api/triage` 有测试：两个仓库各有记录时，顶层 `summary` 为两者之和，`records` 按时间倒序且带 `repoRef`，`pendingSuggestions` 正确。
- [ ] `/triage` 页面按第 4 节显示；切换级别后表格与仓库详情同步更新；`?repo=` 筛选生效。
- [ ] 「只看不一致」只显示符合第 4 节定义的记录。
- [ ] 侧栏出现「分诊」入口与待补充徽章；直接打开 `/triage` 深链接可用。
- [ ] 375px 宽度下两张并排卡片上下排列，表格容器内横向滚动。
- [ ] `bun run check` 通过。

## 7. 不做

- 不改分诊本身的判断、级别语义和 GitHub 侧行为。
- 不做按时间范围筛选（「近 30 天」等）。
