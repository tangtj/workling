import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { upgradeSteps } from '../src/db/schema.ts'
import { loadSteps, parseStepId, runUpgradeSteps, type UpgradeStep } from '../src/upgrade/index.ts'

test('parseStepId 提取版本与两位序号，拒绝不合规文件名', () => {
  expect(parseStepId('v0.10.3-02-move-task-logs.ts')).toEqual({
    version: [0, 10, 3],
    order: 2,
  })
  for (const fileName of [
    '0.3.0-01-move.ts',
    'v0.3-01-move.ts',
    'v0.3.0-1-move.ts',
    'v0.3.0-001-move.ts',
    'v0.3.0-01-Move.ts',
    'v0.3.0-01-move_logs.ts',
    'v0.3.0-01-.ts',
    'v0.3.0-01-move.js',
    'prefix-v0.3.0-01-move.ts',
    'v0.3.0-01-move.ts.bak',
  ])
    expect(parseStepId(fileName)).toBeNull()
})

test('loadSteps 真实导入并按版本数值与序号排序，忽略说明、辅助文件和测试文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling upgrade-'))
  try {
    const ids = [
      'v1.0.0-01-major',
      'v0.10.0-01-minor',
      'v0.9.1-01-patch',
      'v0.9.0-02-second',
      'v0.9.0-01-first',
    ]
    for (const id of ids)
      await writeFile(
        join(dir, `${id}.ts`),
        `export const description = '${id} 说明'; export async function run(ctx) { ctx.log('${id}') }`,
      )
    for (const name of ['README.md', '_helper.ts', 'ignored.test.ts'])
      await writeFile(join(dir, name), '不是可执行模块')
    const steps = await loadSteps(dir)
    expect(steps.map((step) => step.id)).toEqual([...ids].reverse())
    expect(steps[0]?.description).toBe('v0.9.0-01-first 说明')
    const { db, close } = await openDatabase(dir)
    const logs: string[] = []
    try {
      await steps[0]!.run({ db, workspace: dir, log: (message) => logs.push(message) })
      expect(logs).toEqual(['v0.9.0-01-first'])
    } finally {
      close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadSteps 遇到不合规的 TypeScript 文件名直接失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-name-'))
  try {
    await writeFile(join(dir, 'invalid.ts'), '')
    await expect(loadSteps(dir)).rejects.toThrow('升级步骤文件名不合规：invalid.ts')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadSteps 拒绝同一数值版本与序号的重复步骤', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-duplicate-'))
  try {
    await writeFile(join(dir, 'v0.3.0-01-first.ts'), '')
    await writeFile(join(dir, 'v00.03.0-01-second.ts'), '')
    await expect(loadSteps(dir)).rejects.toThrow('升级步骤版本与序号重复')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test.each([
  ['缺少说明', 'export async function run() {}', 'description'],
  ['空白说明', "export const description = '  '; export async function run() {}", 'description'],
  ['说明类型错误', 'export const description = 42; export async function run() {}', 'description'],
  ['缺少函数', "export const description = '说明'", 'run'],
  ['函数类型错误', "export const description = '说明'; export const run = 42", 'run'],
])('loadSteps 拒绝导出无效的步骤：%s', async (_scenario, source, field) => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-exports-'))
  try {
    await writeFile(join(dir, 'v0.3.0-01-invalid.ts'), source)
    await expect(loadSteps(dir)).rejects.toThrow(field)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadSteps 目录不存在时返回空列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-missing-'))
  try {
    expect(await loadSteps(join(dir, 'missing'))).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runUpgradeSteps 顺序执行、持久化说明与时间，重开后不再执行已登记步骤', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-upgrade-run-'))
  let connection = await openDatabase(workspace)
  const calls: string[] = []
  const logs: string[] = []
  const steps: UpgradeStep[] = ['v0.9.0-01-first', 'v0.10.0-01-second'].map((id) => ({
    id,
    description: `${id} 说明`,
    async run(ctx) {
      expect(ctx.db).toBe(connection.db)
      expect(ctx.workspace).toBe(workspace)
      expect(ctx.db.select().from(upgradeSteps).all()).toHaveLength(calls.length)
      calls.push(id)
      ctx.log(`步骤内部 ${id}`)
    },
  }))
  try {
    const log = (message: string) => logs.push(message)
    expect(await runUpgradeSteps({ db: connection.db, workspace, log, steps })).toEqual(
      steps.map((step) => step.id),
    )
    expect(calls).toEqual(steps.map((step) => step.id))
    expect(connection.db.select().from(upgradeSteps).all()).toEqual(
      steps.map((step) => ({
        id: step.id,
        description: step.description,
        appliedAt: expect.any(Date),
      })),
    )
    expect(logs).toEqual(
      steps.flatMap((step) => [
        `执行升级步骤 ${step.id}：${step.description}`,
        `步骤内部 ${step.id}`,
        '完成',
      ]),
    )
    connection.close()
    connection = await openDatabase(workspace)
    expect(await runUpgradeSteps({ db: connection.db, workspace, log, steps })).toEqual([])
    expect(calls).toHaveLength(2)
    expect(logs).toHaveLength(6)
  } finally {
    connection.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('runUpgradeSteps 中间失败保留之前记录，停止后续步骤，修复重开后从失败步骤继续', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-upgrade-retry-'))
  let connection = await openDatabase(workspace)
  const calls: string[] = []
  const logs: string[] = []
  let failing = true
  const steps: UpgradeStep[] = ['v0.3.0-01-first', 'v0.3.0-02-middle', 'v0.3.0-03-last'].map(
    (id, index) => ({
      id,
      description: `${id} 说明`,
      async run(ctx) {
        calls.push(id)
        if (index === 1) {
          // 文件可能已处理但步骤尚未登记；重试覆盖同一内容保持幂等。
          await writeFile(join(ctx.workspace, 'processed.txt'), '完成文件处理')
          if (failing) throw new Error('处理中断')
        }
      },
    }),
  )
  const log = (message: string) => logs.push(message)
  try {
    await expect(runUpgradeSteps({ db: connection.db, workspace, log, steps })).rejects.toThrow(
      '升级步骤 v0.3.0-02-middle 失败：处理中断',
    )
    expect(calls).toEqual(['v0.3.0-01-first', 'v0.3.0-02-middle'])
    expect(connection.db.select({ id: upgradeSteps.id }).from(upgradeSteps).all()).toEqual([
      { id: 'v0.3.0-01-first' },
    ])
    expect(logs).toContain('升级步骤 v0.3.0-02-middle 失败：处理中断')
    expect(await readFile(join(workspace, 'processed.txt'), 'utf8')).toBe('完成文件处理')
    connection.close()
    connection = await openDatabase(workspace)
    failing = false
    expect(await runUpgradeSteps({ db: connection.db, workspace, log, steps })).toEqual([
      'v0.3.0-02-middle',
      'v0.3.0-03-last',
    ])
    expect(calls).toEqual([
      'v0.3.0-01-first',
      'v0.3.0-02-middle',
      'v0.3.0-02-middle',
      'v0.3.0-03-last',
    ])
    expect(connection.db.select().from(upgradeSteps).all()).toHaveLength(3)
    expect(await readFile(join(workspace, 'processed.txt'), 'utf8')).toBe('完成文件处理')
  } finally {
    connection.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
