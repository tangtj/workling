# 更新渠道：stable / edge

> 交给 workling 实现。本文是唯一的设计文档。

## 目标

控制台在线更新目前只能升级到正式 Release（`vX.Y.Z` tag）。为了方便测试刚合入 main 的改动，增加更新渠道：

- **stable（稳定版）**：检查正式 Release，即现有行为，也是默认渠道。
- **edge（尝鲜版）**：检查默认分支 `main` 的最新 commit，可以在线更新到这个 commit。

在线更新本来就是"下载源码包 → 解压 → 安装依赖 → 切换 `current` → 重启"（`src/update/index.ts`），不拉镜像。edge 复用这条流程，只是把下载目标从 tag 换成 commit sha，因此**不改 CI、不发新镜像**。

## 已定的规则

1. **渠道只决定"检查更新去哪查"**。切换渠道不改代码、不重启、不触发更新；要不要更新仍由用户在版本面板点"更新"决定。
2. 渠道设置放在**设置页**，存数据库，默认 `stable`。保存后前端立即强制检查一次更新（等同于 `GET /api/system/version?force=1`），让版本面板马上换成新渠道的结果。
3. edge 的版本号写作 `edge-<commit sha 前 12 位>`（小写十六进制），用于 `VERSION` 文件、`state.json`、`releases/` 下的目录名和数据库备份文件名。
4. 下载时用**完整 40 位 sha**，不用 `main`，避免检查之后 main 又前进，导致下载的代码和检查结果不一致。
5. **只升不降**：通过 GitHub compare 接口判断先后，只有目标版本包含当前 commit 时才提供更新。数据库迁移只能前进，退回旧代码可能读不了已迁移的数据库。
6. edge **不显示更新说明**（不列 commit 列表）；stable 仍按现有方式显示 Release 说明。
7. edge 固定跟踪 `main`，不做成可配置。

## 设计

### 1. 版本号（`src/runtime/version.ts`）

- 新增 `EDGE_PATTERN = '^edge-[0-9a-f]{12}$'`、`isEdge(version)`，以及 `VERSION_PATTERN`（tag、edge 二选一）和 `validVersion(version)`。
- `compareVersions` 仍只比较 tag 和 `dev`，**不能传入 edge 版本**；涉及 edge 的先后一律用 compare 接口判断。在函数注释里写明这一点。

### 2. 渠道设置

- 新增单行表 `update_settings`：`id integer primary key`、`channel text enum('stable','edge') not null`、`updated_at`，写法参照 `executor_settings`。用 `bun run db:generate` 生成迁移。
- 读取函数 `readUpdateChannel(db): 'stable' | 'edge'`：没有这一行时返回 `stable`。写入函数 `updateUpdateChannel(db, channel)` 用 upsert。放在 `src/config/update.ts`。
- API（`src/web/routes/settings.ts`）：
  - `GET /api/settings` 增加 `update: { channel }`，同步更新 `src/web/settings.ts` 的 `settingsSchema`。
  - 新增 `PATCH /api/settings/update`，请求体 `{ channel: 'stable' | 'edge' }`（`additionalProperties: false`），非法返回 400。成功后返回新设置。不检查是否有更新作业在进行，因为切换不影响正在进行的作业。
- 设置页（`src/web/client/pages/settings.tsx`）：
  - 新增"更新渠道"卡片，在 `sections` 中排在"执行器"之后，id 为 `update`。
  - 用两个单选项：`稳定版（stable）`：只更新到正式 Release；`尝鲜版（edge）`：更新到 main 最新提交，可能不稳定。
  - 当前部署不支持在线更新时（`/api/system/version?local=1` 返回 `mode !== 'docker'`），卡片仍可保存，但显示"当前部署方式不支持在线更新"。
  - 保存成功后强制检查一次更新，并让版本面板用的查询失效，使面板显示新渠道的结果。

### 3. GitHub 接口（`src/update/github.ts`）

沿用现有 `headers`、代理、超时、`redirect: 'error'`、按 fetch 隔离的 20 分钟缓存和 `force` 规则，响应都用 typebox 做形状校验。

- `getBranchHead({ repo, branch: 'main', token, proxy, fetch, force, now })`：请求 `GET /repos/{repo}/commits/main`，返回 `{ sha }`，sha 必须是 40 位小写十六进制。
- `compareRefs({ repo, base, head, ... })`：请求 `GET /repos/{repo}/compare/{base}...{head}`，返回 `{ status }`，取值为 `ahead | behind | identical | diverged`，其他值视为响应无效。`base`、`head` 只接受 tag 或 7–40 位十六进制 sha，拼 URL 时逐段 `encodeURIComponent`。
- `downloadTarball` 的 `tag` 参数改名为 `ref`，接受合法 tag 或 40 位小写十六进制 sha，其他值报"非法版本"。

### 4. 检查更新（`versionInfo`）

返回值在现有字段基础上增加：

- `channel: 'stable' | 'edge'`
- `target: { version: string; notes: string; url: string } | null`：可以更新到的版本。`notes` 在 stable 下是 Release 说明，在 edge 下固定为空字符串；`url` 在 stable 下是 Release 页面，在 edge 下是 `https://github.com/{repo}/commit/{完整 sha}`。
- `hasUpdate: boolean`：等价于 `target !== null`。
- `note?: string`：没有更新时的说明，比如"当前尝鲜版比最新正式版新，下一个正式版发布后会出现在这里"。
- 当前版本是 edge 时，`currentUrl` 指向该 commit 页面（本地信息只有 12 位 sha，用 `https://github.com/{repo}/commit/{12 位 sha}`）。

`releases`、`latest` 保留，供 stable 渠道和旧逻辑使用。判断规则如下，其中 `local` 是当前 `VERSION`：

| 渠道   | 当前版本 | 规则                                                                                                                                                                                                                  |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stable | tag      | 和现在一样：`latest` 比 `local` 新时，`target = latest`                                                                                                                                                               |
| stable | edge     | 用 `compareRefs(base = local 的 sha, head = latest.tag)` 比较：`ahead` 或 `identical` 时，`target = latest`（`identical` 也提供，更新后版本号回到正式 tag）；`behind` 或 `diverged` 时，`target = null` 并给出 `note` |
| edge   | tag/edge | 先 `getBranchHead` 取 `head`。`base = local`（tag 名或 12 位 sha）：`ahead` 时 `target = edge-<head 前 12 位>`；`identical` 时没有更新；`behind` 或 `diverged`（比如 main 被强推）时 `target = null` 并给出 `note`    |
| 任意   | `dev`    | 不提供更新，`note = '开发版本无法检查更新'`                                                                                                                                                                           |

GitHub 请求失败时沿用现有 `releaseError` 字段返回错误，不抛出。

### 5. 执行更新（`startUpdate`、`POST /api/system/update`）

- 请求体由 `{ tag, mode }` 改为 `{ target, mode }`，`target` 按 `VERSION_PATTERN` 校验。前端同步修改。
- 服务端**重新计算**一次（`force = true`）当前渠道的检查结果，`target` 必须等于其中的 `target.version`，否则返回 400"目标版本已变化，请重新检查更新"。edge 用重新计算时拿到的完整 sha 下载，不相信前端传来的值。
- 下载目录、`partial`、`tarball` 文件名都用版本号（`edge-xxxxxxxxxxxx` 或 tag）。写入的 `VERSION` 也是这个版本号。
- 新增**契约版本检查**，两个渠道都做：用正则 `/export const CONTRACT_VERSION = (\d+)/` 分别读解压目录和 `imageRoot` 下的 `src/contract/spec.ts`；读不到或不相等时拒绝，提示"该版本修改了任务契约（worker 镜像需要同步更新），不能在线更新，请在服务器执行 ./update.sh 拉取新镜像"。原因是在线更新不会更换 worker 镜像。
- Dockerfile、entrypoint 的哈希检查保持不变。

### 6. 版本号放宽的位置

以下地方现在只接受 tag 和 `dev`，都要加上 edge：

- `src/update/state.ts` 的版本模式。
- `backupDatabase` 的文件名正则。
- `cleanReleases` 里用 `validTag` 过滤目录的地方，改用 `validVersion`。
- `src/web/routes/system.ts` 的请求体校验（见上一节）。
- `deploy/docker/entrypoint.sh` 中的 `validVersion` 与 `readState`。

### 7. 启动时选择代码目录（`deploy/docker/entrypoint.sh`）

现在的规则是：`current` 的版本比镜像版本新就用 `current`，否则用镜像（管理员拉了新镜像后以镜像为准）。edge 版本无法和 tag 比较大小，所以改为：

- `state.json` 增加可选字段 `image`：每次在线更新成功写入状态时，记录当时的镜像版本（`readVersion(imageRoot)`）。`src/update/state.ts` 与 entrypoint 的 `readState` 都允许这个字段。
- `current` 是 tag 版本时，规则不变。
- `current` 是 edge 版本时，只有 `state.image` 等于当前镜像版本才用 `current`；否则视为管理员换了镜像，按现有逻辑清除 `current` 并以镜像为准。
- 自动回滚逻辑不变，只是 `releases/<previous>` 可能是 edge 目录。

### 8. 版本面板（`src/web/client/version-panel.tsx`）

- 用 `target` 代替 `latest` 判断是否有更新，按钮显示"更新到 {target.version}"。
- 头部显示当前渠道（"稳定版"或"尝鲜版"）。当前版本是 edge 时，显示为指向 commit 的链接。
- edge 渠道不显示更新说明区域；stable 保持现状。
- 没有更新且有 `note` 时，显示 `note`。

### 上线顺序

第 7 节改了 entrypoint，按现有规则，这个版本**不能在线更新**，第一次必须在服务器上执行 `./update.sh <新 tag>` 拉取新镜像。之后两个渠道都可以在线更新。

## 验收

- [ ] `bun install --frozen-lockfile --ignore-scripts && bun run check` 通过。
- [ ] `test/version.test.ts`：覆盖 `validVersion`、`isEdge` 对 tag、edge、`dev` 和非法值的判断。
- [ ] `test/update.test.ts`（用 fetch 替身）覆盖：
  - stable + tag：行为与现在一致。
  - stable + edge：compare 返回 `ahead`、`identical` 时提供最新 tag；返回 `behind`、`diverged` 时没有更新并给出 `note`。
  - edge：compare 返回 `ahead` 时 `target` 为 `edge-<12 位>`；`identical` 时没有更新；`behind`、`diverged` 时给出 `note`。
  - `startUpdate` 传入和重新计算结果不一致的 `target` 时返回 400。
  - edge 更新按完整 sha 请求 tarball，写入 `VERSION=edge-<12 位>`，目录名和备份文件名正确，`state.json` 写入 `image`。
  - 契约版本不一致时拒绝更新。
  - `downloadTarball` 拒绝非法 ref。
- [ ] `test/entrypoint.test.ts` 覆盖：
  - `current` 是 edge 且 `state.image` 等于镜像版本时，选 `current`。
  - `state.image` 和镜像版本不同时，清除 `current` 并选镜像。
  - tag 版本的现有用例不变。
- [ ] 设置接口测试覆盖：
  - `GET /api/settings` 默认返回 `update.channel = 'stable'`。
  - `PATCH /api/settings/update` 能保存 `edge`。
  - 非法值或多余字段返回 400。
- [ ] 新增 drizzle 迁移，`drizzle/meta` 同步更新。

## 人工验收

- [ ] 在服务器用 `./update.sh <新 tag>` 升级后，在设置页切到尝鲜版，版本面板立即显示 main 最新提交可更新，且不显示更新说明。
- [ ] 在线更新到 edge 后重启正常，版本面板显示 `edge-xxxx` 并能点开 commit。
- [ ] 切回稳定版后代码不变；在新 tag 发布前提示当前版本比正式版新，发布后可以更新到该 tag。

## 不做

- 不改 CI，不为 main 发布镜像；`deploy/update.sh`、`deploy/docker/update.sh` 不变。
- edge 不显示 commit 列表等更新说明。
- 不支持配置 edge 跟踪的分支，固定为 `main`。
- 不提供手动回滚或降级到旧版本的入口。
- 不增加预发布（`-rc`）渠道。
