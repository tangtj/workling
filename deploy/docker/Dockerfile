FROM node:22-bookworm-slim

COPY --from=oven/bun:1.3.6 /usr/local/bin/bun /usr/local/bin/bun

# 主体镜像只放调度所需的命令：git（镜像缓存与落地）、gh（GitHub 写操作）、docker CLI（拉起 worker 容器）。
# Pi、codex 与给 agent 用的工具只在 worker/Dockerfile 里，任务一律在 worker 镜像中运行。
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg sqlite3 \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod go+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends gh docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

ARG WORKLING_VERSION=dev

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY tsconfig.json ./
# 在线更新比较 Dockerfile 与入口脚本，运行环境变化时拒绝在线更新。
COPY deploy/docker/Dockerfile ./deploy/docker/Dockerfile
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/workling-entrypoint
RUN printf '%s\n' "$WORKLING_VERSION" > /app/VERSION

RUN mkdir -p /data && chown node:node /data
ENV WORKLING_WORKSPACE=/data WORKLING_HOST=0.0.0.0 WORKLING_PORT=7420
USER node
EXPOSE 7420
HEALTHCHECK --interval=30s CMD curl -fsS http://127.0.0.1:7420/health || exit 1
CMD ["workling-entrypoint"]
