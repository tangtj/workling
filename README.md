# workling

English | [中文](README.zh-CN.md)

workling watches GitHub Issues and hands them to [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Pi builds the prompt, calls codex, commits locally and replies on the Issue. workling queues and launches tasks, validates commits before pushing and opening a PR, and updates status labels. It also ships a small admin UI.

```text
Issue labeled workling:ready → serve queues it → launches a task → Pi calls codex and commits locally → serve validates commits, opens a PR and sets workling:done / workling:failed
```

## Requirements

- [Bun](https://bun.sh) 1.3+
- [GitHub CLI](https://cli.github.com) (`gh`) and Git
- [codex](https://github.com/openai/codex) (called by Pi in local process mode; bundled in the worker image)

## Install

```sh
bun install --frozen-lockfile --ignore-scripts
bun link    # optional: register the global `workling` command
```

## Configuration

Configuration lives in two places:

1. **Environment variables**: process-level settings needed before startup. Put them in `.env` at the project root (Bun loads it automatically). All are optional:

   | Variable                  | Default     | Description                                                                                                       |
   | ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
   | `WORKLING_WORKSPACE`      | `.runtime`  | Data directory for the database and task directories, relative to the launch directory                            |
   | `WORKLING_HOST`           | `127.0.0.1` | Admin UI listen address                                                                                           |
   | `WORKLING_PORT`           | `7420`      | Admin UI port                                                                                                     |
   | `WORKLING_WORKER`         | hostname    | Machine identifier, recorded in runs and comments                                                                 |
   | `WORKLING_INTERVAL`       | `60`        | Polling interval (seconds)                                                                                        |
   | `WORKLING_TIMEOUT`        | `90`        | Per-task timeout (minutes)                                                                                        |
   | `WORKLING_KEEP_RUNS`      | `5`         | Task directories kept per Issue                                                                                   |
   | `WORKLING_REWORK_LIMIT`   | `3`         | Max automatic reworks per PR triggered by Request changes; 0 disables them                                        |
   | `WORKLING_ALLOWED_HOSTS`  | none        | Extra allowed host names, comma-separated                                                                         |
   | `WORKLING_SECURE_COOKIE`  | `false`     | Set to `true` when the admin UI is served over HTTPS                                                              |
   | `WORKLING_REQUIRE_DOCKER` | `false`     | When `true`, switch to and keep the Docker executor on start (production)                                         |
   | `WORKLING_WORKER_IMAGE`   | none        | When set, the task image is set to it on every start (compose defaults to the worker image of the host's version) |

2. **Admin UI → Settings** (stored in the database): codex model and reasoning effort, Pi model, LLM base URL and key, commit identity, and executor (local process / Docker container with resource limits). On first start these are imported once from the matching environment variables; after that the admin UI is the source of truth.

## Usage

```sh
bun run start          # or: workling serve
```

1. On first start the admin password is printed to the terminal (shown only once). Open <http://127.0.0.1:7420> and sign in.
2. Under **Settings**, fill in the LLM base URL and key.
3. Under **Repos**, add a repository (e.g. `github:owner/repo`) with a token that can read and write its Issues, code and pull requests. workling creates the `workling:*` labels in that repository.
4. Label an Issue `workling:ready`. The Issue body is the prompt for codex and may include images and documents; optional `模型：` / `强度：` lines override the default model and reasoning effort. For larger designs, keep the documents on a branch and add a `分支：<name>` line; the task branch is created from it.
5. Follow progress and logs in the admin UI. Results show up as labels: `workling:queued` → `workling:running` → `workling:done` / `workling:failed`. To retry a failed Issue, add `workling:ready` again.

## Adopting in other projects

After setup, development tasks in the target repository work like this: the local AI assistant writes requirements and design documents and creates an Issue, a person adds `workling:ready`, and workling implements it and opens a PR. Developers of that repository only need an authenticated `gh`; they do not install workling.

1. Register the repository under **Repos** in the admin UI (GitHub only for now).
2. In the target repository, send this prompt to your local AI coding assistant (Claude Code, Codex, Cursor, etc.):

   ```text
   Set up this repository for workling following https://raw.githubusercontent.com/tangtj/workling/main/templates/SETUP.md:
   - On a new branch, write the three files it lists into this repository: docs/workling.md, the two rules in AGENTS.md, and the GitHub Issue template.
   - Fill in the repository-specific section at the end of docs/workling.md from this repository; ask me when unsure.
   - Change only these files, not application code. Open a setup PR and give me the link.
   ```

3. Review and merge the setup PR. From then on, tell the local assistant to hand a task to workling.

To update the setup later:

```text
Update this repository's workling setup following https://raw.githubusercontent.com/tangtj/workling/main/templates/SETUP.md, keep the repository-specific section at the end of docs/workling.md, and open a PR
```

Without an AI assistant, copy the files under [templates/repo/](templates/repo/) into the repository by hand as described in [templates/SETUP.md](templates/SETUP.md). The templates are in Chinese.

## Commands

| Command                       | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `workling serve`              | Start the service: polling, tasks, reconciliation, admin UI |
| `workling cancel <issue ref>` | Cancel a running task                                       |
| `workling reset-password`     | Reset the admin password and sign out all sessions          |

Without `bun link`, replace `workling` with `bun src/cli.ts`. Run `cancel` and `reset-password` from the directory serve was started in, or set the same `WORKLING_WORKSPACE`. Issue references look like `github:owner/repo#12` or `https://github.com/owner/repo/issues/12`.

After signing in, you can change the password on the settings page; use `workling reset-password` if you forget it.

## Deployment

Docker files live in `deploy/docker/`; systemd files live in `deploy/`. Either way the admin UI listens only on `127.0.0.1:7420`; reach it remotely through an SSH tunnel: `ssh -L 7420:127.0.0.1:7420 <server>`.

### Recommended: Docker

The host and the worker ship as two images. The host image (`WORKLING_IMAGE`) schedules, serves the admin UI and performs GitHub writes; it includes common command-line tools but not codex. For each task the host launches a worker container through the host's Docker (`WORKLING_IMAGE` with a `-worker` suffix, released with the same version). Both images include common command-line tools: `rg`, `fd`, `jq`, `less`, `file`, `tree`, `patch`, `unzip`, `xz`, `ps`, `lsof`, `make`, `python3`, and `sqlite3`; add worker-only tools to `worker/Dockerfile`.

The host container mounts the host's `/var/run/docker.sock` (root-equivalent on the host) and joins the docker group via `DOCKER_GID`; compose sets `WORKLING_REQUIRE_DOCKER=true`, so the executor is always Docker. Worker containers mount only their own task directory, never get docker.sock and cannot see the host's database. If the worker image is not present locally, the host runs `docker pull` before the first launch (private images need `docker login ghcr.io` on the host first).

- **Build from source and run**: create a `.env` in the repository root (it may be empty), then run (this builds both the host and worker images)

  ```sh
  DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose -f deploy/docker/docker-compose.build.yaml up -d --build
  ```

- **Use a pushed image**: copy `deploy/docker/docker-compose.yaml` and `deploy/docker/.env.example` to a deployment directory on the server, rename the latter to `.env`, set `WORKLING_IMAGE`, `WORKLING_VERSION` and `DOCKER_GID`, then run `docker compose up -d`.
- **Upgrading from the single-container version**: older versions ran the host and worker in one container with the local process executor. Replace `docker-compose.yaml` in the deployment directory with the new `deploy/docker/docker-compose.yaml`, add `DOCKER_GID` (the output of `getent group docker | cut -d: -f3`) to `.env`, then run `./update.sh <tag>`. The data volume stays as is; on start the executor switches to Docker and the task image comes from `WORKLING_WORKER_IMAGE` (by default the worker image of the same version).
- **Release and update**: publish to GHCR by pushing a tag as described below. Update or roll back online from **the sidebar version badge**, or run `./update.sh <tag>` to pull a new image when the Dockerfile or entrypoint changes.

The first-start admin password is in the logs: `docker compose logs workling | grep -A1 管理密码`. After signing in, set the LLM base URL and key in Settings, then add repositories. Data lives in the named volume `workling-data` by default and survives container rebuilds; to keep it in a host directory, set `WORKLING_DATA_DIR` in `.env` (the directory must be writable by uid 1000).

### Releases

Publish by creating and pushing a tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The version comes only from the tag and is written to `/app/VERSION` in the image at build time. The version in `package.json` does not participate in releases. Running the source locally displays `dev`.

Actions installs dependencies and runs checks, builds a `linux/amd64` image with the official Docker Actions, pushes it to GHCR, and creates a GitHub Release. Stable releases generate `v0.2.0`, `v0.2`, and `latest` image tags. Prereleases such as `v0.2.0-rc.1` generate only the full tag, are marked as prereleases, and stay out of the online update list. The GHCR package must allow this repository's Actions to write with `GITHUB_TOKEN`.

For code updates, use **the sidebar version badge** after setting `WORKLING_UPDATE_REPO` and, for private repositories, a read-only `WORKLING_UPDATE_TOKEN`. `WORKLING_UPDATE_PROXY` covers GitHub requests, source downloads and dependency installation. Updates pause new task launches and wait for running tasks to finish before backing up the database, switching code and restarting. You can cancel while waiting or choose to update immediately and interrupt running tasks. To return to an older version, run `./update.sh <old tag>` on the server. Older versions may not be able to read a migrated database; restore a compatible backup from `/data/backups` as needed. The page shows the last successful update and its time. Three consecutive failed starts of a new version trigger automatic rollback and restore the database backup taken before the update.

Changes to either `deploy/docker/Dockerfile` or `deploy/docker/entrypoint.sh` require a new image: online updates reject them, and you must run `./update.sh <tag>` from the deployment directory. That script backs up the database, updates the Compose configuration and checks health, restoring the previous version and database on failure. Online code survives in the data volume; the entrypoint compares versions using SemVer and selects the image when it is newer.

**Releasing only the worker**: push a `worker-v*` tag (for example `git tag worker-v0.1.0 && git push origin worker-v0.1.0`). Actions builds `worker/Dockerfile` and pushes `ghcr.io/<repo>-worker` tagged `v0.1.0`, `contract-<contract version>` and `latest` (prereleases get only the full version). The image label `io.workling.contract` declares the contract version; the Docker executor checks it before launching and, if it does not match the host, pauses new tasks and shows the reason on the overview and in the sidebar. Point **Task image** in Settings at the new worker image to use it without upgrading the host.

Build a specific version locally for testing (the default is `dev`):

```sh
WORKLING_VERSION=v0.1.1 docker compose -f deploy/docker/docker-compose.build.yaml build
```

### Alternative: systemd

systemd runs watch on the host, and each task runs in its own container that mounts only that task's directory. Containers are launched through **rootless Docker**: root inside a container maps only to the service user, and the service user does not join the docker group.

1. Install Bun and Docker's rootless components (`docker-ce-rootless-extras`, `uidmap`), create the service user and enable rootless Docker for it:

   ```sh
   sudo useradd -r -m -d /var/lib/workling workling
   sudo loginctl enable-linger workling
   sudo -iu workling dockerd-rootless-setuptool.sh install
   ```

   Resource limits under rootless need the cgroup controllers delegated to the user; otherwise `--memory`, `--cpus` and `--pids-limit` have no effect, and workling pauses launching and shows the reason in the admin UI:

   ```sh
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```

2. Put the code in `/opt/workling`, install dependencies and build the worker image (its name must match **Task image** in Settings, `workling:local` by default):

   ```sh
   cd /opt/workling && bun install --frozen-lockfile --ignore-scripts --production
   sudo -iu workling env DOCKER_HOST=unix:///run/user/$(id -u workling)/docker.sock \
     docker build -f /opt/workling/worker/Dockerfile -t workling:local /opt/workling
   ```

3. Copy `deploy/workling.env.example` to `/etc/workling/workling.env` (mode 600, owned by workling) and set the uid in `DOCKER_HOST` to the output of `id -u workling`.
   `WORKLING_SANDBOX=docker` in the env file is imported as the Docker executor on first start, and `WORKLING_REQUIRE_DOCKER=true` keeps it from being switched back to the local process executor. Workers run on the `workling-worker` network that workling creates (created with inter-container traffic disabled, which relies on Docker's iptables rules on Linux), and the host listens only on `127.0.0.1:7420`, so workers cannot reach the admin port.
4. Install and start the service: `sudo cp deploy/workling.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now workling`.
5. The first-start admin password: `journalctl -u workling | grep -A1 管理密码`.
6. To upgrade, run `deploy/update.sh <tag>` in `/opt/workling`.

## Development

```sh
bun run dev            # restart serve on code changes
bun run check          # format check, lint, type check and tests
bun run format         # format the code
bun run db:generate    # generate a migration after editing src/db/schema.ts
```

### Running the worker alone

The worker does not need serve: give it a prepared run directory (`spec.json`, `input/`, `repo/`) and it runs Pi and writes its outputs to `out/`. The bundled samples help compare prompts or models:

```sh
workling-worker samples                                        # list samples in worker/samples/
workling-worker prepare add-function /tmp/run-a                # expand into a run directory with a fixed base commit
workling-worker prepare add-function /tmp/run-b --codex-model gpt-6-luna --effort low
workling-worker run /tmp/run-a                                 # run it; outputs land in /tmp/run-a/out/
```

Without `bun link`, replace `workling-worker` with `bun worker/cli.ts`. To use a custom model endpoint, write `secrets/llm.json` (`{ baseUrl, apiKey, api }`) into the run directory; otherwise the local codex / Pi login is used.

Contribution conventions are in [AGENTS.md](AGENTS.md) (Chinese).

## Layout

```text
src/
├── cli.ts       command entry
├── config/      configuration: environment, Pi, executor
├── db/          database schema and connection
├── serve/       long-running service: polling, launching, reconciliation
├── contract/    host–worker contract: spec, outputs, task directory and report format
├── executor/    executors: local process / Docker
├── issue/       Issue reference parsing and reading
├── platform/    GitHub calls
├── web/         admin UI: routes, views, static assets
└── runtime/     subprocess, path and other low-level helpers
worker/          worker: single-run entry, Pi orchestration, Pi conventions (configs/)
drizzle/         database migrations
deploy/          Docker and systemd deployment files
```

## License

MIT
