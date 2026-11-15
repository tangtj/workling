# workling

English | [中文](README.zh-CN.md)

workling watches GitHub Issues and hands them to [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Pi builds the prompt and calls codex to change the code, then commits, pushes, opens a PR and replies on the Issue. workling handles polling, queueing, launching tasks, reconciliation and status labels, and ships a small admin UI.

```text
Issue labeled workling:ready → serve queues it → launches a task → Pi calls codex → Pi opens a PR → serve reconciles and sets workling:done / workling:failed
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- [GitHub CLI](https://cli.github.com) (`gh`) and Git
- [codex](https://github.com/openai/codex) (called by Pi in local process mode; bundled in the Docker image)

## Install

```sh
bun install --frozen-lockfile --ignore-scripts
bun link    # optional: register the global `workling` command
```

## Configuration

Configuration lives in two places:

1. **Environment variables**: process-level settings needed before startup. Put them in `.env` at the project root (Bun loads it automatically). All are optional:

   | Variable                 | Default     | Description                                                                            |
   | ------------------------ | ----------- | -------------------------------------------------------------------------------------- |
   | `WORKLING_WORKSPACE`     | `.runtime`  | Data directory for the database and task directories, relative to the launch directory |
   | `WORKLING_HOST`          | `127.0.0.1` | Admin UI listen address                                                                |
   | `WORKLING_PORT`          | `7420`      | Admin UI port                                                                          |
   | `WORKLING_WORKER`        | hostname    | Machine identifier, recorded in runs and comments                                      |
   | `WORKLING_INTERVAL`      | `60`        | Polling interval (seconds)                                                             |
   | `WORKLING_TIMEOUT`       | `90`        | Per-task timeout (minutes)                                                             |
   | `WORKLING_KEEP_RUNS`     | `5`         | Task directories kept per Issue                                                        |
   | `WORKLING_ALLOWED_HOSTS` | none        | Extra allowed host names, comma-separated                                              |
   | `WORKLING_SECURE_COOKIE` | `false`     | Set to `true` when the admin UI is served over HTTPS                                   |

2. **Admin UI → Settings** (stored in the database): codex model and reasoning effort, Pi model, LLM base URL and key, commit identity, and executor (local process / Docker container with resource limits). On first start these are imported once from the matching environment variables; after that the admin UI is the source of truth.

## Usage

```sh
bun run start          # or: workling serve
```

1. On first start the admin password is printed to the terminal (shown only once). Open <http://127.0.0.1:7420> and sign in.
2. Under **Settings**, fill in the LLM base URL and key.
3. Under **Repos**, add a repository (e.g. `github:owner/repo`) with a token that can read and write its Issues, code and pull requests. workling creates the `workling:*` labels in that repository.
4. Label an Issue `workling:ready`. The Issue body is the prompt for codex and may include images and documents; optional `模型：` / `强度：` lines override the default model and reasoning effort.
5. Follow progress and logs in the admin UI. Results show up as labels: `workling:queued` → `workling:running` → `workling:done` / `workling:failed`. To retry a failed Issue, add `workling:ready` again.

## Commands

| Command                       | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `workling serve`              | Start the service: polling, tasks, reconciliation, admin UI |
| `workling cancel <issue ref>` | Cancel a running task                                       |
| `workling reset-password`     | Reset the admin password and sign out all sessions          |

Without `bun link`, replace `workling` with `bun src/cli.ts`. `task` and `read` are internal commands invoked by serve and Pi. Run `cancel` and `reset-password` from the directory serve was started in, or set the same `WORKLING_WORKSPACE`. Issue references look like `github:owner/repo#12` or `https://github.com/owner/repo/issues/12`.

## Deployment

Docker files live in `deploy/docker/`; systemd files live in `deploy/`. Either way the admin UI listens only on `127.0.0.1:7420`; reach it remotely through an SSH tunnel: `ssh -L 7420:127.0.0.1:7420 <server>`.

### Recommended: Docker

watch, tasks, Pi and codex run in one container, so select **local process** as the executor in Settings (the container has no docker command).

- **Build from source and run**: create a `.env` in the repository root (it may be empty), then run

  ```sh
  docker compose -f deploy/docker/docker-compose.build.yaml up -d --build
  ```

- **Use a pushed image**: copy `deploy/docker/docker-compose.yaml` and `deploy/docker/.env.example` to a deployment directory on the server, rename the latter to `.env`, set `WORKLING_IMAGE` and `WORKLING_VERSION`, then run `docker compose up -d`.

The first-start admin password is in the logs: `docker compose logs workling | grep -A1 管理密码`. After signing in, set the LLM base URL and key in Settings, then add repositories. Data lives in the named volume `workling-data` by default and survives container rebuilds; to keep it in a host directory, set `WORKLING_DATA_DIR` in `.env` (the directory must be writable by uid 1000).

### Alternative: systemd

systemd runs watch on the host, and each task runs in its own container that mounts only that task's directory.

1. Install Bun and Docker, and create a service user in the docker group (docker group membership is root-equivalent; grant it to this account only): `sudo useradd -r -m -d /var/lib/workling -G docker workling`.
2. Put the code in `/opt/workling`, install dependencies and build the task image:

   ```sh
   cd /opt/workling && bun install --frozen-lockfile --ignore-scripts --production
   docker build -f deploy/docker/Dockerfile -t workling:local .
   ```

3. Copy `deploy/workling.env.example` to `/etc/workling/workling.env` (mode 600, owned by workling).
4. Install and start the service: `sudo cp deploy/workling.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now workling`.
5. The first-start admin password: `journalctl -u workling | grep -A1 管理密码`.

## Development

```sh
bun run dev            # restart serve on code changes
bun run check          # format check, lint, type check and tests
bun run format         # format the code
bun run db:generate    # generate a migration after editing src/db/schema.ts
```

Contribution conventions are in [AGENTS.md](AGENTS.md) (Chinese).

## Layout

```text
src/
├── cli.ts       command entry
├── config/      configuration: environment, Pi, executor
├── db/          database schema and connection
├── serve/       long-running service: polling, launching, reconciliation
├── task/        a single task: clone, run Pi, task directory contract
├── executor/    executors: local process / Docker
├── issue/       Issue reference parsing and reading
├── platform/    GitHub calls
├── web/         admin UI: routes, views, static assets
└── runtime/     subprocess, path and other low-level helpers
configs/         Pi working conventions (system prompt)
drizzle/         database migrations
deploy/          Docker and systemd deployment files
```

## License

MIT
