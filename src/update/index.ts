import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { count, eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { issues } from '../db/schema.ts'
import { ROOT } from '../runtime/paths.ts'
import { run } from '../runtime/process.ts'
import type { Command } from '../runtime/types.ts'
import { readVersion, compareVersions, validTag } from '../runtime/version.ts'
import { redact } from '../contract/report.ts'
import { downloadTarball, listReleases, repoPath, type UpdateFetch } from './github.ts'
import { readState, writeState, type UpdateState } from './state.ts'

export type UpdateJob = {
  kind: 'update'
  tag: string
  status: 'running' | 'waiting' | 'done' | 'failed'
  logs: string[]
  startedAt: string
  error?: string
}
function updateError(message: string, status: 400 | 409) {
  return Object.assign(new Error(message), { status })
}
let busy = false
let job: UpdateJob | null = null
export const getJob = (): UpdateJob | null => job
export const launchPaused = (): boolean => busy
let control: { job: UpdateJob; controller: AbortController; done: Promise<void> } | null = null

export async function cancelJob(): Promise<UpdateJob> {
  if (!control || control.job.status !== 'waiting') throw updateError('仅等待中的作业可以取消', 409)
  const current = control
  current.controller.abort(new Error('已取消'))
  // 清理完成后才返回，避免下一次更新与旧作业共用临时目录和锁。
  await current.done
  return current.job
}

function runningTasks(db: WorklingDatabase): number {
  return db.select({ count: count() }).from(issues).where(eq(issues.status, 'running')).get()!.count
}

async function waitForDrain(
  db: WorklingDatabase,
  active: UpdateJob,
  mode: 'drain' | 'now',
  signal: AbortSignal,
  interval: number,
) {
  if (mode === 'now') return
  let previous = -1
  for (;;) {
    signal.throwIfAborted()
    const remaining = runningTasks(db)
    if (remaining === 0) break
    active.status = 'waiting'
    if (remaining !== previous) active.logs.push(`等待 ${remaining} 个运行中的任务结束`)
    previous = remaining
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, interval)
      signal.addEventListener('abort', finish, { once: true })
    })
  }
  active.status = 'running'
}

export function updateMode(): { appHome: string; imageRoot: string } | null {
  const { WORKLING_APP_HOME: appHome, WORKLING_IMAGE_ROOT: imageRoot } = process.env
  return appHome && imageRoot ? { appHome: resolve(appHome), imageRoot: resolve(imageRoot) } : null
}

// 初始页面只读取本地信息；检查更新接口才会联系 GitHub。
export function localVersionInfo(db: WorklingDatabase, root = ROOT) {
  const mode = updateMode()
  const state = mode ? readState(mode.appHome) : null
  let releasesUrl: string | null = null
  if (process.env.WORKLING_UPDATE_REPO) {
    try {
      releasesUrl = `https://github.com/${repoPath(process.env.WORKLING_UPDATE_REPO)}/releases`
    } catch {
      // 无效配置交由检查更新接口报告，本地信息仍可读取。
    }
  }
  return {
    releasesUrl,
    current: readVersion(root),
    image: mode ? readVersion(mode.imageRoot) : readVersion(root),
    mode: mode ? ('docker' as const) : ('unsupported' as const),
    repoConfigured: Boolean(process.env.WORKLING_UPDATE_REPO),
    previous: state?.previous ?? null,
    runningTasks: runningTasks(db),
    lastError: state?.lastError ?? null,
    lastSuccess: state?.lastSuccess ?? null,
    job,
  }
}

export async function versionInfo({
  db,
  force = false,
  fetch,
}: {
  db: WorklingDatabase
  force?: boolean
  fetch?: UpdateFetch
}) {
  const local = localVersionInfo(db)
  let releases: Awaited<ReturnType<typeof listReleases>> = []
  let releaseError: string | undefined
  if (local.repoConfigured) {
    try {
      releases = await listReleases({
        repo: process.env.WORKLING_UPDATE_REPO!,
        token: process.env.WORKLING_UPDATE_TOKEN,
        force,
        fetch,
      })
    } catch (error) {
      releaseError = safeError(error)
    }
  }
  const latest = releases[0] ?? null
  return {
    ...local,
    releases,
    latest,
    hasUpdate: Boolean(latest && compareVersions(latest.tag, local.current) > 0),
    ...(releaseError ? { releaseError } : {}),
  }
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error), [
    process.env.WORKLING_UPDATE_TOKEN ?? '',
  ])
}
function requireMode() {
  const mode = updateMode()
  if (!mode) throw updateError('当前部署方式不支持在线更新', 409)
  return mode
}
async function lock(appHome: string) {
  if (busy) throw updateError('已有更新作业在进行', 409)
  busy = true
  try {
    await mkdir(appHome, { recursive: true })
    const file = await open(join(appHome, 'update.lock'), 'wx', 0o600)
    await file.close()
  } catch (error) {
    busy = false
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw updateError('已有更新作业在进行', 409)
    throw error
  }
}
function unlock(appHome: string) {
  try {
    rmSync(join(appHome, 'update.lock'), { force: true })
  } finally {
    busy = false
  }
}
function switchCurrent(appHome: string, target: string | null) {
  const current = join(appHome, 'current')
  if (target === null) {
    rmSync(current, { force: true })
    return
  }
  const temp = join(appHome, `current.${crypto.randomUUID()}.tmp`)
  try {
    symlinkSync(target, temp)
    renameSync(temp, current)
  } finally {
    rmSync(temp, { force: true })
  }
}
function currentTarget(appHome: string): string | null {
  try {
    return readlinkSync(join(appHome, 'current'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
function commit(appHome: string, next: UpdateState, target: string | null) {
  const old = readState(appHome)
  const oldTarget = currentTarget(appHome)
  const revert = () => {
    switchCurrent(appHome, oldTarget)
    if (old) writeState(appHome, old)
    else rmSync(join(appHome, 'state.json'), { force: true })
  }
  try {
    writeState(appHome, next)
    switchCurrent(appHome, target)
  } catch (error) {
    revert()
    throw error
  }
  return revert
}
async function cleanReleases(appHome: string, state: UpdateState) {
  const root = join(appHome, 'releases')
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.endsWith('.partial'))
      await rm(join(root, entry.name), { recursive: true, force: true })
  }
  const dirs = entries.filter((entry) => entry.isDirectory() && validTag(entry.name))
  const others = dirs.filter((entry) => ![state.current, state.previous].includes(entry.name))
  const dated = await Promise.all(
    others.map(async (entry) => ({
      name: entry.name,
      mtime: (await stat(join(root, entry.name))).mtimeMs,
    })),
  )
  dated.sort((a, b) => b.mtime - a.mtime)
  for (const entry of dated.slice(1))
    await rm(join(root, entry.name), { recursive: true, force: true })
  await rm(join(appHome, 'tmp'), { recursive: true, force: true })
}
async function backupDatabase(data: string, version: string) {
  const dir = join(data, 'backups')
  await mkdir(dir, { recursive: true })
  const name = `workling-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${version}-${crypto.randomUUID()}.db`
  if (!/^workling-[0-9TZ]+-(?:dev|v[0-9A-Za-z.-]+)-[0-9a-f-]+\.db$/.test(name))
    throw new Error('数据库备份路径无效')
  const path = join(dir, name)
  const sqlite = new Database(join(data, 'workling.db'), { readonly: false, strict: true })
  try {
    sqlite.run('VACUUM INTO ?', [path])
  } finally {
    sqlite.close()
  }
  await chmod(path, 0o600)
  const backups = await Promise.all(
    (await readdir(dir))
      .filter((name) => /^workling-[0-9A-Za-z.-]+\.db$/.test(name))
      .map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })),
  )
  backups.sort((a, b) => b.mtime - a.mtime)
  for (const old of backups.slice(10)) await rm(join(dir, old.name))
  return path
}

type UpdateOptions = {
  db: WorklingDatabase
  mode?: 'drain' | 'now'
  drainIntervalMs?: number
  command?: Command
  fetch?: UpdateFetch
  exit?: (code: number) => void
  root?: string
  data?: string
}
async function executeJob(
  appHome: string,
  active: UpdateJob,
  action: () => Promise<void>,
  exit: (code: number) => void,
) {
  try {
    await action()
    active.logs.push('即将重启')
    active.status = 'done'
    await Bun.sleep(500)
    // process.exit 不会执行 finally；退出前释放文件锁，内存锁仍阻止新请求。
    rmSync(join(appHome, 'update.lock'), { force: true })
    exit(0)
  } catch (error) {
    active.status = 'failed'
    active.error = safeError(error)
    active.logs.push(active.error)
  } finally {
    unlock(appHome)
    control = null
  }
}

export async function startUpdate({
  tag,
  db,
  mode: taskMode = 'drain',
  drainIntervalMs = 5000,
  command = run,
  fetch,
  exit = process.exit,
  root = ROOT,
  data = '/data',
}: { tag: string } & UpdateOptions): Promise<UpdateJob> {
  const mode = requireMode()
  if (!validTag(tag)) throw updateError('非法 tag', 400)
  await lock(mode.appHome)
  try {
    const repo = process.env.WORKLING_UPDATE_REPO
    if (!repo) throw updateError('请在 .env 配置 WORKLING_UPDATE_REPO', 400)
    const releases = await listReleases({ repo, token: process.env.WORKLING_UPDATE_TOKEN, fetch })
    if (
      !releases.some((release) => release.tag === tag) ||
      compareVersions(tag, readVersion(root)) <= 0
    )
      throw updateError('只能升级到 Release 列表中比当前版本更新的版本', 400)
    const active: UpdateJob = {
      kind: 'update',
      tag,
      status: 'running',
      logs: [],
      startedAt: new Date().toISOString(),
    }
    job = active
    const controller = new AbortController()
    // 作业在响应之后继续，所有失败都在 executeJob 中收敛成可轮询的状态。
    const done = executeJob(
      mode.appHome,
      active,
      async () => {
        const releasesDir = join(mode.appHome, 'releases')
        const partial = join(releasesDir, `${tag}.partial`)
        const target = join(releasesDir, tag)
        const tarball = join(mode.appHome, 'tmp', `${tag}.tar.gz`)
        try {
          await mkdir(dirname(tarball), { recursive: true })
          await mkdir(releasesDir, { recursive: true })
          await rm(partial, { recursive: true, force: true })
          await mkdir(partial)
          active.logs.push(`下载 ${tag}`)
          await downloadTarball({
            repo,
            tag,
            token: process.env.WORKLING_UPDATE_TOKEN,
            dest: tarball,
            fetch,
          })
          active.logs.push('解压并校验版本文件')
          await command(['tar', '-xzf', tarball, '--strip-components=1', '-C', partial])
          for (const file of [
            'package.json',
            'src/cli.ts',
            'worker/cli.ts',
            'drizzle/meta/_journal.json',
            'deploy/docker/Dockerfile',
            'deploy/docker/entrypoint.sh',
          ]) {
            const valid = await lstat(join(partial, file)).catch(() => null)
            if (
              !valid?.isFile() ||
              !realpathSync(join(partial, file)).startsWith(`${realpathSync(partial)}/`)
            )
              throw new Error(`版本缺少有效文件：${file}`)
          }
          const hash = async (path: string) =>
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          for (const file of ['deploy/docker/Dockerfile', 'deploy/docker/entrypoint.sh']) {
            if ((await hash(join(partial, file))) !== (await hash(join(mode.imageRoot, file))))
              throw new Error(
                `该版本修改了运行环境（${file}），不能在线更新，请在服务器执行 ./update.sh ${tag} 拉取新镜像`,
              )
          }
          active.logs.push('安装生产依赖')
          await command(
            ['bun', 'install', '--frozen-lockfile', '--ignore-scripts', '--production'],
            {
              cwd: partial,
              signal: AbortSignal.timeout(10 * 60_000),
              env: {
                ...process.env,
                ...(process.env.WORKLING_UPDATE_PROXY
                  ? {
                      HTTPS_PROXY: process.env.WORKLING_UPDATE_PROXY,
                      HTTP_PROXY: process.env.WORKLING_UPDATE_PROXY,
                    }
                  : {}),
              },
            },
          )
          await writeFile(join(partial, 'VERSION'), `${tag}\n`)
          await rm(target, { recursive: true, force: true })
          await rename(partial, target)
          await waitForDrain(db, active, taskMode, controller.signal, drainIntervalMs)
          active.logs.push('备份数据库')
          const current = readVersion(root)
          const backup = await backupDatabase(data, current)
          const lastSuccess = readState(mode.appHome)?.lastSuccess
          const state: UpdateState = {
            ...(lastSuccess ? { lastSuccess } : {}),
            current: tag,
            previous: current,
            previousIsImage: realpathSync(root) === realpathSync(mode.imageRoot),
            backup,
            pending: true,
            attempts: 0,
            updatedAt: new Date().toISOString(),
          }
          active.logs.push('切换当前版本')
          const revert = commit(mode.appHome, state, target)
          try {
            await cleanReleases(mode.appHome, state)
          } catch (error) {
            // 退出重启前仍可恢复指针与状态，失败作业不能留下已经切换的版本。
            revert()
            throw error
          }
        } finally {
          // 失败分支不能让清理错误掩盖原始原因。
          await rm(partial, { recursive: true, force: true }).catch(() =>
            active.logs.push('临时目录清理失败'),
          )
          await rm(tarball, { force: true }).catch(() => active.logs.push('下载文件清理失败'))
        }
      },
      exit,
    )
    control = { job: active, controller, done }
    return active
  } catch (error) {
    unlock(mode.appHome)
    throw error
  }
}

export function markHealthy(root = ROOT): void {
  const mode = updateMode()
  if (!mode) return
  const state = readState(mode.appHome)
  if (state?.pending && state.current === readVersion(root))
    writeState(mode.appHome, {
      ...state,
      pending: false,
      attempts: 0,
      lastSuccess: { tag: state.current, at: new Date().toISOString() },
    })
}
