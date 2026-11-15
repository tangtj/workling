import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorklingDatabase } from '../db/index.ts'
import { upgradeSteps } from '../db/schema.ts'
import { errorMessage } from '../runtime/errors.ts'
import { ROOT } from '../runtime/paths.ts'

export type UpgradeContext = {
  db: WorklingDatabase
  workspace: string
  log: (message: string) => void
}

export type UpgradeStep = {
  id: string
  description: string
  run: (ctx: UpgradeContext) => Promise<void>
}

export function parseStepId(
  fileName: string,
): { version: [number, number, number]; order: number } | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)-(\d{2})-[a-z0-9-]+\.ts$/.exec(fileName)
  if (!match) return null
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    order: Number(match[4]),
  }
}

export async function loadSteps(dir = resolve(ROOT, 'src/upgrade/steps')): Promise<UpgradeStep[]> {
  const files = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  const positions = new Set<string>()
  const candidates = []
  for (const file of files) {
    if (
      !file.isFile() ||
      !file.name.endsWith('.ts') ||
      file.name.endsWith('.test.ts') ||
      file.name.startsWith('_')
    )
      continue
    const parsed = parseStepId(file.name)
    if (!parsed) throw new Error(`升级步骤文件名不合规：${file.name}`)
    const position = `${parsed.version.join('.')}-${parsed.order}`
    if (positions.has(position)) throw new Error(`升级步骤版本与序号重复：${file.name}`)
    positions.add(position)
    candidates.push({ fileName: file.name, ...parsed })
  }
  candidates.sort(
    (a, b) =>
      a.version[0] - b.version[0] ||
      a.version[1] - b.version[1] ||
      a.version[2] - b.version[2] ||
      a.order - b.order,
  )
  const steps: UpgradeStep[] = []
  for (const { fileName } of candidates) {
    const step = await import(pathToFileURL(resolve(dir, fileName)).href)
    if (typeof step.description !== 'string' || !step.description.trim())
      throw new Error(`升级步骤 ${fileName} 必须导出非空 description`)
    if (typeof step.run !== 'function') throw new Error(`升级步骤 ${fileName} 必须导出 run 函数`)
    steps.push({ id: fileName.slice(0, -3), description: step.description, run: step.run })
  }
  return steps
}

export async function runUpgradeSteps({
  db,
  workspace,
  log,
  steps,
}: UpgradeContext & { steps: UpgradeStep[] }): Promise<string[]> {
  const applied = new Set(
    db
      .select({ id: upgradeSteps.id })
      .from(upgradeSteps)
      .all()
      .map((row) => row.id),
  )
  const executed: string[] = []
  for (const step of steps) {
    if (applied.has(step.id)) continue
    log(`执行升级步骤 ${step.id}：${step.description}`)
    try {
      // 文件操作不能随数据库回滚；不包大事务，保留之前已完成步骤的记录。
      // 进程可能在执行中或登记前退出，因此步骤必须可安全重复执行。
      await step.run({ db, workspace, log })
      db.insert(upgradeSteps)
        .values({ id: step.id, description: step.description, appliedAt: new Date() })
        .run()
      applied.add(step.id)
      executed.push(step.id)
      log('完成')
    } catch (error) {
      const message = `升级步骤 ${step.id} 失败：${errorMessage(error)}`
      log(message)
      throw new Error(message, { cause: error })
    }
  }
  return executed
}
