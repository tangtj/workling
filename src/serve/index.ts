import {
  importExecutorSettings,
  readExecutorSettings,
  updateExecutorSettings,
} from '../config/executor.ts'
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
import { reconcile, recoverOrphanFeedback } from './reconcile.ts'
import { syncPullRequests } from './pr-sync.ts'
import { queueRework } from './rework.ts'
import { ensureWorkerImage } from '../executor/worker-image.ts'
import { checkDockerHost } from '../executor/docker-host.ts'
import { observeFeedback, type FeedbackState } from './feedback.ts'
import { triageIssues, type TriageState } from './triage.ts'
import { waitForNext } from './wait.ts'
type Log = (message: string) => void

export type ServeStatus = {
  worker: string
  interval: number
  timeout: number
  reworkLimit: number
  startedAt: Date
  lastPollAt: Date | null
  lastPollError: string | null
  /** docker 执行器的 worker 镜像不兼容时的原因；此时暂停拉起新任务。 */
  workerError?: string | null
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
    reworkLimit: settings.reworkLimit,
    startedAt: new Date(),
    lastPollAt: null,
    lastPollError: null,
    workerError: null,
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
    // 部署要求 Docker 执行器时，旧库里的本机进程执行器一次性切换过来。
    if (settings.requireDocker && readExecutorSettings(db).sandbox !== 'docker') {
      updateExecutorSettings(db, { sandbox: 'docker' })
      log('已按 WORKLING_REQUIRE_DOCKER=true 切换为 Docker 执行器')
    }
    // compose 部署由 .env 决定 worker 镜像，随主体版本一起升级；设置了它时每次启动覆盖设置页的任务镜像。
    const workerImage = env.WORKLING_WORKER_IMAGE?.trim()
    if (workerImage && readExecutorSettings(db).taskImage !== workerImage) {
      updateExecutorSettings(db, { taskImage: workerImage })
      log(`任务镜像已按 WORKLING_WORKER_IMAGE 设为 ${workerImage}`)
    }
    const password = await ensurePassword(db)
    if (password)
      log(
        `\n========================================\n首次启动，已生成管理密码（只显示这一次）：\n${password}\n忘记密码可运行 bun src/cli.ts reset-password\n========================================\n`,
      )
    try {
      recoverOrphanFeedback(db)
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
    const feedbackState: FeedbackState = { accounts: new Map(), permissions: new Map() }
    const triageState: TriageState = { permissions: new Map() }
    let wasPaused = false
    let warnedRootful = false
    const pulledImages = new Set<string>()
    let previousWake: Awaited<ReturnType<typeof waitForNext>> = 'interval'
    while (!signal.aborted) {
      let expanded = 0
      const pi = readPiSettings(db)
      const executorSettings = readExecutorSettings(db)
      try {
        await reconcile({ db, command, log, settings, pi, executorSettings })
      } catch (error) {
        log(`对账失败：${errorMessage(error)}`)
      }
      try {
        await syncPullRequests({ db, command, log, signal, workspace: settings.workspace })
      } catch (error) {
        if (!signal.aborted) log(`PR 同步失败：${errorMessage(error)}`)
      }
      try {
        ;({ expanded } = await pollOnce({ db, command, signal, log, labeledRepos }))
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
          await triageIssues({ db, command, log, signal, state: triageState })
        } catch (error) {
          if (!signal.aborted) log(`分诊失败：${errorMessage(error)}`)
        }
        try {
          await observeFeedback({ db, command, log, signal, state: feedbackState })
        } catch (error) {
          if (!signal.aborted) log(`观察反馈失败：${errorMessage(error)}`)
        }
        try {
          await queueRework({ db, command, log, signal, reworkLimit: settings.reworkLimit })
        } catch (error) {
          if (!signal.aborted) log(`指令重试失败：${errorMessage(error)}`)
        }
      }
      if (!signal.aborted) {
        try {
          const paused = launchPaused()
          if (paused && !wasPaused) log('在线更新进行中，暂停拉起新任务')
          wasPaused = paused
          let workerError: string | null = null
          if (settings.requireDocker && executorSettings.sandbox !== 'docker')
            workerError =
              '已设置 WORKLING_REQUIRE_DOCKER=true，本机进程执行器不可用；请在设置页把执行器改为 Docker'
          else if (executorSettings.sandbox === 'docker') {
            const host = await checkDockerHost(command)
            if (!host.error && !host.rootless && !warnedRootful) {
              warnedRootful = true
              log(
                '提示：Docker 不是 rootless 模式，worker 容器逃逸即获得宿主机 root；建议改用 rootless Docker 并设置 DOCKER_HOST',
              )
            }
            workerError =
              host.error ??
              (await ensureWorkerImage(command, executorSettings.taskImage, pulledImages, log))
          }
          if (workerError && workerError !== status.workerError)
            log(`暂停拉起新任务：${workerError}`)
          status.workerError = workerError
          if (!paused && !workerError)
            await launchQueued({
              db,
              command,
              log,
              settings,
              pi,
              executorSettings,
              signal,
            })
        } catch (error) {
          log(`拉起任务失败：${errorMessage(error)}`)
        }
      }
      if (!signal.aborted) {
        previousWake = await waitForNext({
          seconds: settings.interval,
          signal,
          db,
          immediate: expanded > 0 && previousWake !== 'immediate',
        })
        if (previousWake === 'finished') log('有任务结束，提前开始下一轮')
      }
    }
  } finally {
    server?.stop(true)
    close()
  }
}
