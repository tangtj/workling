FROM node:22-bookworm-slim

COPY --from=oven/bun:1.3.6 /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.166.0

ARG WORKLING_VERSION=dev

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY configs/ ./configs/
COPY tsconfig.json ./
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/workling-entrypoint
RUN printf '%s\n' "$WORKLING_VERSION" > /app/VERSION

RUN mkdir -p /data && chown node:node /data
ENV WORKLING_WORKSPACE=/data WORKLING_HOST=0.0.0.0 WORKLING_PORT=7420
# 容器默认不允许创建用户命名空间，codex 的 workspace-write（bwrap）在这里必然失败；
# 隔离边界由容器本身（及 docker 执行器的单任务容器）提供，codex 不再套内层沙箱。
ENV WORKLING_CODEX_SANDBOX=danger-full-access
USER node
EXPOSE 7420
HEALTHCHECK --interval=30s CMD curl -fsS http://127.0.0.1:7420/health || exit 1
CMD ["workling-entrypoint"]
