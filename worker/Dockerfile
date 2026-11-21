# worker 镜像：只含 worker/ 与 src/contract/，不含主体、数据库与 GitHub 凭证工具。
# 构建：docker build -f worker/Dockerfile -t workling-worker:local .
FROM node:22-bookworm-slim

COPY --from=oven/bun:1.3.6 /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    ripgrep fd-find jq less file tree patch unzip xz-utils procps lsof make python3 sqlite3 \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.166.0

ARG WORKER_VERSION=dev
# 必须与 src/contract/spec.ts 的 CONTRACT_VERSION 一致（test/worker-image.test.ts 检查）；
# 主体拉起前读取这个标签，不兼容时不拉起任务。
ARG WORKER_CONTRACT=2
LABEL io.workling.contract=$WORKER_CONTRACT io.workling.worker-version=$WORKER_VERSION

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY src/contract/ ./src/contract/
COPY worker/ ./worker/
RUN printf '%s\n' "$WORKER_VERSION" > /app/WORKER_VERSION

# 隔离边界由单任务容器提供，容器内不能创建用户命名空间，codex 不再套内层沙箱。
ENV WORKLING_CODEX_SANDBOX=danger-full-access
USER node
CMD ["bun", "--no-env-file", "worker/cli.ts"]
