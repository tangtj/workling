# workling

[English](README.md) | 中文

监听 GitHub Issue，自动交给 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 处理：Pi 组装提示词并调用 codex 改代码，在任务分支上本地提交并回复 Issue。workling 负责轮询、排队、拉起任务、校验提交、推送并建 PR、更新状态标签，并提供一个管理页。

```text
Issue 打上 workling:ready → serve 入队 → 拉起 task → Pi 调用 codex 并本地提交 → serve 校验提交并建 PR，标签改为 workling:done / workling:failed
```

## 前置依赖

- [Bun](https://bun.sh) 1.3+
- [GitHub CLI](https://cli.github.com)（`gh`）与 Git
- [codex](https://github.com/openai/codex)（本机进程模式下由 Pi 调用；Docker 模式下 worker 镜像内已包含）

## 安装

```sh
bun install --frozen-lockfile --ignore-scripts
bun link    # 可选：注册全局命令 workling
```

## 配置

配置分两部分：

1. **环境变量**：启动前需要的进程级配置，写在项目根目录的 `.env`（Bun 启动时自动加载）。全部可选：

   | 变量                      | 默认值      | 说明                                                                           |
   | ------------------------- | ----------- | ------------------------------------------------------------------------------ |
   | `WORKLING_WORKSPACE`      | `.runtime`  | 数据目录：数据库与任务目录，相对路径按启动目录解析                             |
   | `WORKLING_HOST`           | `127.0.0.1` | 管理页监听地址                                                                 |
   | `WORKLING_PORT`           | `7420`      | 管理页端口                                                                     |
   | `WORKLING_WORKER`         | 主机名      | 本机标识，写入运行记录与评论                                                   |
   | `WORKLING_INTERVAL`       | `60`        | 轮询间隔（秒）                                                                 |
   | `WORKLING_TIMEOUT`        | `90`        | 单个任务超时（分钟）                                                           |
   | `WORKLING_KEEP_RUNS`      | `5`         | 每个 Issue 保留的任务目录数                                                    |
   | `WORKLING_REWORK_LIMIT`   | `3`         | 每个 PR 由 Request changes 自动触发的返工轮数上限，0 表示不自动返工            |
   | `WORKLING_ALLOWED_HOSTS`  | 无          | 额外允许的访问域名，逗号分隔                                                   |
   | `WORKLING_SECURE_COOKIE`  | `false`     | 通过 HTTPS 访问管理页时设为 `true`                                             |
   | `WORKLING_REQUIRE_DOCKER` | `false`     | 设为 `true` 时启动即切换并固定为 Docker 执行器（生产部署）                     |
   | `WORKLING_WORKER_IMAGE`   | 无          | 设置后每次启动把任务镜像设为该值（compose 部署默认与主体同版本的 worker 镜像） |

2. **管理页「设置」**（存数据库）：codex 模型与推理强度、Pi 模型、LLM 接入地址与 Key、提交身份、执行器（本机进程 / Docker 容器及资源限制）。首次启动时会从同名环境变量导入一次，之后以管理页为准。

## 使用

```sh
bun run start          # 或 workling serve
```

1. 首次启动会在终端打印管理密码（只显示一次），打开 <http://127.0.0.1:7420> 登录。
2. 在「设置」里填好 LLM 接入地址与 Key。
3. 在「仓库」里添加仓库（如 `github:owner/repo`）和 token。token 需要能读写该仓库的 Issue、代码与 PR。添加后 workling 会在仓库里创建 `workling:*` 标签。
4. 给 Issue 打上 `workling:ready`。正文就是给 codex 的提示词，可附图片与文档；可选写 `模型：`、`强度：` 行覆盖默认值；设计文档较多时放在文档分支上，正文加 `分支：<名称>` 行，任务分支会从该分支切出。
5. 在管理页查看进度与日志。结果以标签呈现：`workling:queued` → `workling:running` → `workling:done` / `workling:failed`；失败后重新打上 `workling:ready` 即可重试。

## 在其他项目接入

接入后，业务仓库的开发类任务改为：本地 AI 写需求与设计文档、建 Issue，人打上 `workling:ready`，由 workling 实现并发起 PR。业务仓库的开发者只需要已登录的 `gh`，不需要安装 workling。

1. 在管理页「仓库」中登记业务仓库（目前只支持 GitHub）。
2. 在业务仓库里，把下面的提示词发给本地 AI 编码助手（Claude Code、Codex、Cursor 等）：

   ```text
   按 https://raw.githubusercontent.com/tangtj/workling/main/templates/SETUP.md 把这个仓库接入 workling：
   - 新建分支，把其中列出的三个文件写入本仓库：docs/workling.md、AGENTS.md 中的两行规则、GitHub Issue 模板；
   - 按本仓库实际情况填写 docs/workling.md 末尾的「本仓库约定」，拿不准的先问我；
   - 只改这些文件，不改业务代码，最后发起接入 PR 并给我链接。
   ```

3. 审阅并合并接入 PR。之后对本地 AI 说「这个需求交给 workling」即可。

更新接入文档时发送：

```text
按 https://raw.githubusercontent.com/tangtj/workling/main/templates/SETUP.md 更新本仓库的 workling 接入文档，保留「本仓库约定」，发起 PR
```

不用 AI 时，照 [templates/SETUP.md](templates/SETUP.md) 手动把 [templates/repo/](templates/repo/) 下的文件复制到业务仓库对应位置。

## 命令

| 命令                           | 说明                                   |
| ------------------------------ | -------------------------------------- |
| `workling serve`               | 启动服务：轮询、拉起任务、对账、管理页 |
| `workling cancel <issue 引用>` | 取消运行中的任务                       |
| `workling reset-password`      | 重置管理密码，已登录会话全部失效       |

未执行 `bun link` 时把 `workling` 换成 `bun src/cli.ts`。`cancel`、`reset-password` 要在启动 serve 的同一目录执行，或设置相同的 `WORKLING_WORKSPACE`。Issue 引用格式：`github:owner/repo#12` 或 `https://github.com/owner/repo/issues/12`。

登录后也可在设置页修改密码；忘记密码时使用 `workling reset-password`。

## 部署

Docker 相关文件都在 `deploy/docker/`，systemd 相关文件在 `deploy/`。两种方式的管理接口都只监听本机 `127.0.0.1:7420`，远程访问用 SSH 隧道：`ssh -L 7420:127.0.0.1:7420 <服务器>`。

### 推荐：Docker

主体与 worker 分成两个镜像：主体镜像（`WORKLING_IMAGE`）负责调度、Web 和对 GitHub 的写操作，带常用命令行工具但不含 codex；每个任务由主体通过宿主机的 Docker 拉起一个 worker 容器（`WORKLING_IMAGE` 加 `-worker` 后缀，与主体同版本发布）。两个镜像都预装了常用命令行工具：`rg`、`fd`、`jq`、`less`、`file`、`tree`、`patch`、`unzip`、`xz`、`ps`、`lsof`、`make`、`python3` 和 `sqlite3`，worker 专用的新工具只加到 `worker/Dockerfile`。

主体容器挂载宿主机的 `/var/run/docker.sock`（等同宿主机 root 权限），并以 `DOCKER_GID` 加入 docker 组；compose 设置了 `WORKLING_REQUIRE_DOCKER=true`，执行器固定为 Docker。worker 容器只挂载自己的任务目录，拿不到 docker.sock，也看不到主体的数据库。worker 镜像不在本机时，主体在第一次拉起前自动 `docker pull`（私有镜像需先在宿主机 `docker login ghcr.io`）。

- **从源码构建并运行**：在仓库根目录准备好 `.env`（可以为空），然后执行（同时构建主体与 worker 镜像）

  ```sh
  DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose -f deploy/docker/docker-compose.build.yaml up -d --build
  ```

- **使用已推送的镜像**：把 `deploy/docker/docker-compose.yaml` 和 `deploy/docker/.env.example` 复制到服务器的部署目录，后者改名为 `.env`，填写 `WORKLING_IMAGE`、`WORKLING_VERSION` 与 `DOCKER_GID`，再执行 `docker compose up -d`。
- **从单容器版本升级**：旧版本的主体和 worker 在同一个容器里，执行器是「本机进程」。升级时先用新的 `deploy/docker/docker-compose.yaml` 替换部署目录里的同名文件，在 `.env` 里加上 `DOCKER_GID=$(getent group docker | cut -d: -f3)` 的值，再执行 `./update.sh <tag>`。数据卷不用迁移；启动后执行器会自动切换为 Docker，任务镜像取 `WORKLING_WORKER_IMAGE`（默认与主体同版本的 worker 镜像）。
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

**主体与 worker 分开发布**：两个镜像各有一个工作流（`release.yml`、`release-worker.yml`），互不阻塞、可分别重跑。推送 `v*` tag 时两者并行构建，worker 镜像 `ghcr.io/<仓库>-worker` 得到同版本标签（`v0.2.0`、`v0.2`、`contract-<契约版本>`、`latest`），compose 默认按主体版本取用。**只更新 worker** 时推送 `worker-v*` tag（如 `git tag worker-v0.1.0 && git push origin worker-v0.1.0`），只构建 worker，标签为 `worker-v0.1.0` 与 `contract-<契约版本>`；然后在 `.env` 设置 `WORKLING_WORKER_IMAGE=ghcr.io/<仓库>-worker:worker-v0.1.0` 并 `docker compose up -d`（systemd 部署改设置页的「任务镜像」），主体不用升级。镜像标签 `io.workling.contract` 声明契约版本；docker 执行器拉起前检查，与主体不一致时暂停拉起新任务，并在管理页概览与侧栏提示原因。

本地可构建指定版本用于实测（默认 `dev`）：

```sh
WORKLING_VERSION=v0.1.1 docker compose -f deploy/docker/docker-compose.build.yaml build
```

### 备选：systemd

watch 由 systemd 运行在宿主机上，每个任务启动一个独立容器，只挂载该任务的目录。容器通过 **rootless Docker** 拉起：容器内的 root 只映射到服务用户，服务用户也不需要加入 docker 组。

1. 安装 Bun 与 Docker 的 rootless 组件（`docker-ce-rootless-extras`、`uidmap`），创建服务用户并为它启用 rootless Docker：

   ```sh
   sudo useradd -r -m -d /var/lib/workling workling
   sudo loginctl enable-linger workling
   sudo -iu workling dockerd-rootless-setuptool.sh install
   ```

   rootless 下的资源限制需要把 cgroup 控制器委派给用户，否则 `--memory`、`--cpus`、`--pids-limit` 不生效，workling 会暂停拉起并在管理页提示：

   ```sh
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```

2. 把代码放到 `/opt/workling`，安装依赖并构建 worker 镜像（镜像名与设置页「任务镜像」一致，默认 `workling:local`）：

   ```sh
   cd /opt/workling && bun install --frozen-lockfile --ignore-scripts --production
   sudo -iu workling env DOCKER_HOST=unix:///run/user/$(id -u workling)/docker.sock \
     docker build -f /opt/workling/worker/Dockerfile -t workling:local /opt/workling
   ```

3. 把 `deploy/workling.env.example` 复制为 `/etc/workling/workling.env`（权限 600，属主 workling），把其中 `DOCKER_HOST` 的 uid 改成 `id -u workling` 的结果。
   环境文件里的 `WORKLING_SANDBOX=docker` 在首次启动时导入为 Docker 执行器，`WORKLING_REQUIRE_DOCKER=true` 防止之后被改回本机进程。worker 默认运行在 workling 自动创建的 `workling-worker` 网络（创建时关闭容器间互访，依赖 Linux 上 Docker 的 iptables 规则），主体只监听 `127.0.0.1:7420`，worker 访问不到管理端口。
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

### 单独运行 worker

worker 不依赖 serve：给它一个准备好的运行目录（`spec.json`、`input/`、`repo/`），它就会拉起 Pi 并把产出写进 `out/`。内置样例可以用来比较不同提示词或模型的效果：

```sh
workling-worker samples                                        # 列出 worker/samples/ 下的样例
workling-worker prepare add-function /tmp/run-a                # 展开成运行目录，基点固定
workling-worker prepare add-function /tmp/run-b --codex-model gpt-6-luna --effort low
workling-worker run /tmp/run-a                                 # 执行，产出在 /tmp/run-a/out/
```

未执行 `bun link` 时把 `workling-worker` 换成 `bun worker/cli.ts`。需要自定义模型服务时在运行目录写入 `secrets/llm.json`（`{ baseUrl, apiKey, api }`），否则使用本机 codex / Pi 的登录。

开发约定见 [AGENTS.md](AGENTS.md)。

## 目录

```text
src/
├── cli.ts       命令入口
├── config/      配置：环境变量、Pi、执行器
├── db/          数据库 schema 与连接
├── serve/       常驻服务：轮询、拉起、对账
├── contract/    主体与 worker 的契约：spec、产出、任务目录与报告格式
├── executor/    执行器：本机进程 / Docker
├── issue/       Issue 引用解析与读取
├── platform/    GitHub 调用
├── web/         管理页：路由、页面、静态资源
└── runtime/     子进程、路径等底层工具
worker/          worker：单次运行入口、Pi 编排、Pi 工作约定（configs/）
drizzle/         数据库迁移
deploy/          Docker 与 systemd 部署文件
```

## 许可

MIT
