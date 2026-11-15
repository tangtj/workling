# workling

[English](README.md) | 中文

监听 GitHub Issue，自动交给 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 处理：Pi 组装提示词并调用 codex 改代码，再由 Pi 提交、推送、建 PR 并在 Issue 下回复。workling 负责轮询、排队、拉起任务、对账和更新标签，并提供一个管理页。

```text
Issue 打上 workling:ready → serve 入队 → 拉起 task → Pi 调用 codex 改代码 → Pi 建 PR → serve 对账，标签改为 workling:done / workling:failed
```

## 前置依赖

- [Bun](https://bun.sh) 1.3+
- [GitHub CLI](https://cli.github.com)（`gh`）与 Git
- [codex](https://github.com/openai/codex)（本机进程模式下由 Pi 调用；Docker 模式下镜像内已包含）

## 安装

```sh
bun install --frozen-lockfile --ignore-scripts
bun link    # 可选：注册全局命令 workling
```

## 配置

配置分两部分：

1. **环境变量**：启动前需要的进程级配置，写在项目根目录的 `.env`（Bun 启动时自动加载）。全部可选：

   | 变量                     | 默认值      | 说明                                               |
   | ------------------------ | ----------- | -------------------------------------------------- |
   | `WORKLING_WORKSPACE`     | `.runtime`  | 数据目录：数据库与任务目录，相对路径按启动目录解析 |
   | `WORKLING_HOST`          | `127.0.0.1` | 管理页监听地址                                     |
   | `WORKLING_PORT`          | `7420`      | 管理页端口                                         |
   | `WORKLING_WORKER`        | 主机名      | 本机标识，写入运行记录与评论                       |
   | `WORKLING_INTERVAL`      | `60`        | 轮询间隔（秒）                                     |
   | `WORKLING_TIMEOUT`       | `90`        | 单个任务超时（分钟）                               |
   | `WORKLING_KEEP_RUNS`     | `5`         | 每个 Issue 保留的任务目录数                        |
   | `WORKLING_ALLOWED_HOSTS` | 无          | 额外允许的访问域名，逗号分隔                       |
   | `WORKLING_SECURE_COOKIE` | `false`     | 通过 HTTPS 访问管理页时设为 `true`                 |

2. **管理页「设置」**（存数据库）：codex 模型与推理强度、Pi 模型、LLM 接入地址与 Key、提交身份、执行器（本机进程 / Docker 容器及资源限制）。首次启动时会从同名环境变量导入一次，之后以管理页为准。

## 使用

```sh
bun run start          # 或 workling serve
```

1. 首次启动会在终端打印管理密码（只显示一次），打开 <http://127.0.0.1:7420> 登录。
2. 在「设置」里填好 LLM 接入地址与 Key。
3. 在「仓库」里添加仓库（如 `github:owner/repo`）和 token。token 需要能读写该仓库的 Issue、代码与 PR。添加后 workling 会在仓库里创建 `workling:*` 标签。
4. 给 Issue 打上 `workling:ready`。正文就是给 codex 的提示词，可附图片与文档；可选写 `模型：`、`强度：` 行覆盖默认值。
5. 在管理页查看进度与日志。结果以标签呈现：`workling:queued` → `workling:running` → `workling:done` / `workling:failed`；失败后重新打上 `workling:ready` 即可重试。

## 命令

| 命令                           | 说明                                   |
| ------------------------------ | -------------------------------------- |
| `workling serve`               | 启动服务：轮询、拉起任务、对账、管理页 |
| `workling cancel <issue 引用>` | 取消运行中的任务                       |
| `workling reset-password`      | 重置管理密码，已登录会话全部失效       |

未执行 `bun link` 时把 `workling` 换成 `bun src/cli.ts`。`task` 与 `read` 是内部命令，由 serve 和 Pi 调用。`cancel`、`reset-password` 要在启动 serve 的同一目录执行，或设置相同的 `WORKLING_WORKSPACE`。Issue 引用格式：`github:owner/repo#12` 或 `https://github.com/owner/repo/issues/12`。

## 部署

Docker 相关文件都在 `deploy/docker/`，systemd 相关文件在 `deploy/`。两种方式的管理接口都只监听本机 `127.0.0.1:7420`，远程访问用 SSH 隧道：`ssh -L 7420:127.0.0.1:7420 <服务器>`。

### 推荐：Docker

watch、task、Pi、codex 运行在同一个容器里，设置页的执行器要选「本机进程」（容器内没有 docker 命令）。

- **从源码构建并运行**：在仓库根目录准备好 `.env`（可以为空），然后执行

  ```sh
  docker compose -f deploy/docker/docker-compose.build.yaml up -d --build
  ```

- **使用已推送的镜像**：把 `deploy/docker/docker-compose.yaml` 和 `deploy/docker/.env.example` 复制到服务器的部署目录，后者改名为 `.env`，填写 `WORKLING_IMAGE` 与 `WORKLING_VERSION`，再执行 `docker compose up -d`。
- **发布与更新**：按下方 tag 流程发布到 GHCR。之后可以在管理页「侧栏版本徽标」在线更新；Dockerfile 或入口脚本变化时执行 `./update.sh <tag>` 拉新镜像。

首次启动的管理密码在日志里：`docker compose logs workling | grep -A1 管理密码`。登录后在「设置」填写 LLM 接入地址与 Key，再登记仓库。数据默认保存在命名卷 `workling-data` 中，重建容器不会丢失；想放到宿主机目录，在 `.env` 里设置 `WORKLING_DATA_DIR`（该目录需对 uid 1000 可写）。

### 发布

发布只需创建并推送 tag：

```sh
git tag v0.2.0 && git push origin v0.2.0
```

版本号只来自 tag，构建时写入镜像的 `/app/VERSION`；`package.json` 的 version 不参与发布。本地直接运行源码显示 `dev`。

Actions 安装依赖并运行检查，使用官方 Docker Actions 构建 `linux/amd64` 镜像推送 GHCR，再创建 GitHub Release。正式版生成 `v0.2.0`、`v0.2` 与 `latest` 镜像标签；预发布如 `v0.2.0-rc.1` 只有完整 tag，Release 标为预发布，不出现在在线更新列表。GHCR 包须允许该仓库 Actions 使用 `GITHUB_TOKEN` 写入。

管理页「侧栏版本徽标」用于只换代码的在线更新：配置 `WORKLING_UPDATE_REPO`，私有仓库另配只读 `WORKLING_UPDATE_TOKEN`；`WORKLING_UPDATE_PROXY` 同时用于 GitHub 请求、源码下载与依赖安装。默认暂停拉起新任务，等待运行中任务结束后备份数据库、切换代码并重启；等待期间可以取消，也可选择立即升级并中断运行中的任务。回退旧版本请在服务器执行 `./update.sh <旧 tag>`；旧版本可能无法读取已迁移的新库，需配合 `/data/backups` 下的备份恢复。页面显示上次成功升级的版本与时间；新版本连续 3 次启动失败会自动回滚并恢复升级前的数据库备份。

`deploy/docker/Dockerfile` 或 `deploy/docker/entrypoint.sh` 任一变化，在线更新会拒绝，必须在部署目录执行 `./update.sh <tag>` 拉取新镜像。脚本会备份数据库、更新 Compose 配置并检查健康状态，失败时恢复旧版本与数据库。在线代码保存在数据卷，入口脚本按 SemVer 选择镜像与在线版本；镜像版本更高时以镜像为准。

本地可构建指定版本用于实测（默认 `dev`）：

```sh
WORKLING_VERSION=v0.1.1 docker compose -f deploy/docker/docker-compose.build.yaml build
```

### 备选：systemd

watch 由 systemd 运行在宿主机上，每个任务启动一个独立容器，只挂载该任务的目录。

1. 安装 Bun 与 Docker，创建服务用户并加入 docker 组（docker 组等同 root 权限，只给这个账号）：`sudo useradd -r -m -d /var/lib/workling -G docker workling`。
2. 把代码放到 `/opt/workling`，安装依赖并构建任务镜像：

   ```sh
   cd /opt/workling && bun install --frozen-lockfile --ignore-scripts --production
   docker build -f deploy/docker/Dockerfile -t workling:local .
   ```

3. 把 `deploy/workling.env.example` 复制为 `/etc/workling/workling.env`（权限 600，属主 workling）。
4. 安装并启动服务：`sudo cp deploy/workling.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now workling`。
5. 首次启动的管理密码：`journalctl -u workling | grep -A1 管理密码`。
6. 升级：在 `/opt/workling` 执行 `deploy/update.sh <tag>`。

## 开发

```sh
bun run dev            # 改代码后自动重启 serve
bun run check          # 格式、lint、类型检查与测试
bun run format         # 格式化
bun run db:generate    # 修改 src/db/schema.ts 后生成迁移
```

开发约定见 [AGENTS.md](AGENTS.md)。

## 目录

```text
src/
├── cli.ts       命令入口
├── config/      配置：环境变量、Pi、执行器
├── db/          数据库 schema 与连接
├── serve/       常驻服务：轮询、拉起、对账
├── task/        单次任务：克隆仓库、拉起 Pi、任务目录约定
├── executor/    执行器：本机进程 / Docker
├── issue/       Issue 引用解析与读取
├── platform/    GitHub 调用
├── web/         管理页：路由、页面、静态资源
└── runtime/     子进程、路径等底层工具
configs/         Pi 的工作约定（系统提示）
drizzle/         数据库迁移
deploy/          Docker 与 systemd 部署文件
```

## 许可

MIT
