import { importExecutorSettings, readExecutorSettings } from '../config/executor.ts'
import { ensurePassword } from '../web/auth.ts'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/index.ts'
import { repos } from '../db/schema.ts'
import { run } from '../runtime/process.ts'
import { importPiSettings, readPiSettings } from '../config/pi.ts'
import type { Command, Environment } from '../runtime/types.ts'
import { createApp } from '../web/app.ts'
import { getWebBundle } from '../web/bundle.ts'
import type { Settings } from '../config/env.ts'

import { markHealthy, launchPaused } from '../update/index.ts'
import { errorMessage } from '../runtime/errors.ts'
import { loadSteps, runUpgradeSteps, type UpgradeStep } from '../upgrade/index.ts'
import { pollOnce } from './poll.ts'
import { launchQueued } from './launch.ts'
import { reconcile } from './reconcile.ts'
import { syncPullRequests } from './pr-sync.ts'
import { retryOnCommand, type RetryState } from './retry.ts'
type Log = (message: string) => void

export type ServeStatus = {
  worker: string
  interval: number
  timeout: number
  startedAt: Date
  lastPollAt: Date | null
  lastPollError: string | null
}

function waitForNext(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, seconds * 1000)
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function serve({
  settings,
  command = run,
  log = console.log,
  signal,
  env = process.env,
  upgradeSteps,
}: {
  settings: Settings
  command?: Command
  log?: Log
  signal: AbortSignal
  env?: Environment
  upgradeSteps?: UpgradeStep[]
}) {
  const { db, close } = await openDatabase(settings.workspace)
  const status: ServeStatus = {
    worker: settings.worker,
    interval: settings.interval,
    timeout: settings.timeout,
    startedAt: new Date(),
    lastPollAt: null,
    lastPollError: null,
  }
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    await runUpgradeSteps({
      db,
      workspace: settings.workspace,
      log,
      steps: upgradeSteps ?? (await loadSteps()),
    })
    const { imported, ignored } = importPiSettings(db, env)
    if (imported) log('已从环境变量导入 Pi 配置')
    if (ignored.length > 0) log(`以下环境变量已不再生效，请在设置页修改：${ignored.join('、')}`)
    const executorImport = importExecutorSettings(db, env)
    if (executorImport.imported) log('已从环境变量导入执行器配置')
    if (executorImport.ignored.length > 0)
      log(`以下环境变量已不再生效，请在设置页修改：${executorImport.ignored.join('、')}`)
    const password = await ensurePassword(db)
    if (password)
      log(
        `\n========================================\n首次启动，已生成管理密码（只显示这一次）：\n${password}\n忘记密码可运行 bun src/cli.ts reset-password\n========================================\n`,
      )
    try {
      await reconcile({
        db,
        command,
        log,
        settings,
        pi: readPiSettings(db),
        executorSettings: readExecutorSettings(db),
      })
    } catch (error) {
      log(`启动对账失败：${errorMessage(error)}`)
    }
    const app = createApp(db, {
      workspace: settings.workspace,
      secrets: () => [
        ...db
          .select()
          .from(repos)
          .where(eq(repos.enabled, true))
          .all()
          .map((repo) => repo.token),
        readPiSettings(db).llmApiKey ?? '',
        env.WORKLING_UPDATE_TOKEN ?? '',
      ],
      allowedHosts: settings.allowedHosts,
      secureCookie: settings.secureCookie,
      status: () => status,
      startup: {
        workspace: settings.workspace,
        worker: settings.worker,
        host: settings.host,
        port: settings.port,
        secureCookie: settings.secureCookie,
        allowedHosts: settings.allowedHosts.filter(
          (host) => !['127.0.0.1', 'localhost', '::1'].includes(host),
        ),
      },
    })
    await getWebBundle()
    server = Bun.serve({ hostname: settings.host, port: settings.port, fetch: app.fetch })
    markHealthy()
    log(`workling 管理接口：http://${settings.host}:${server.port}`)
    const labeledRepos = new Set<number>()
    const retryState: RetryState = { accounts: new Map(), triggers: new Map() }
    let wasPaused = false
    while (!signal.aborted) {
      const pi = readPiSettings(db)
      const executorSettings = readExecutorSettings(db)
      try {
        await reconcile({ db, command, log, settings, pi, executorSettings })
      } catch (error) {
        log(`对账失败：${errorMessage(error)}`)
      }
      try {
        await syncPullRequests({ db, command, log, signal })
      } catch (error) {
        if (!signal.aborted) log(`PR 同步失败：${errorMessage(error)}`)
      }
      try {
        await pollOnce({ db, command, signal, log, labeledRepos })
        status.lastPollAt = new Date()
        status.lastPollError = null
      } catch (error) {
        if (!signal.aborted) {
          status.lastPollAt = new Date()
          status.lastPollError = error instanceof Error ? error.message : String(error)
          log(`轮询失败：${status.lastPollError}`)
        }
      }
      if (!signal.aborted) {
        try {
          await retryOnCommand({ db, command, log, signal, state: retryState })
        } catch (error) {
          if (!signal.aborted) log(`指令重试失败：${errorMessage(error)}`)
        }
      }
      if (!signal.aborted) {
        try {
          const paused = launchPaused()
          if (paused && !wasPaused) log('在线更新进行中，暂停拉起新任务')
          wasPaused = paused
          if (!paused)
            await launchQueued({
              db,
              command,
              log,
              settings,
              pi,
              executorSettings,
              signal,
              triggers: retryState.triggers,
            })
        } catch (error) {
          log(`拉起任务失败：${errorMessage(error)}`)
        }
      }
      if (!signal.aborted) await waitForNext(settings.interval, signal)
    }
  } finally {
    server?.stop(true)
    close()
  }
}
