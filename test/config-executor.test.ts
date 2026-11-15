import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { executorSettings } from '../src/db/schema.ts'
import {
  type ExecutorSettings,
  parseExecutorSettings,
  readExecutorSettings,
  updateExecutorSettings,
  importExecutorSettings,
} from '../src/config/executor.ts'

const defaults: ExecutorSettings = {
  concurrency: 3,
  sandbox: 'none',
  taskImage: 'workling:local',
  taskCpus: 2,
  taskMemory: '4g',
  taskPids: 1024,
  taskNetwork: null,
}

async function database() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-executor-settings-'))
  const { db, close } = await openDatabase(dir)
  return {
    db,
    async dispose() {
      close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('缺省配置使用默认值，空表读取不写入，读取被篡改的持久化行时报错', async () => {
  const s = await database()
  try {
    expect(parseExecutorSettings({})).toEqual(defaults)
    expect(readExecutorSettings(s.db)).toEqual(defaults)
    expect(s.db.select().from(executorSettings).all()).toEqual([])
    updateExecutorSettings(s.db, {})
    s.db.update(executorSettings).set({ taskImage: ' ' }).where(eq(executorSettings.id, 1)).run()
    expect(() => readExecutorSettings(s.db)).toThrow('taskImage 的值无效： ')
  } finally {
    await s.dispose()
  }
})

test.each([
  ['concurrency', 0],
  ['concurrency', 33],
  ['concurrency', 1.5],
  ['concurrency', '5'],
  ['sandbox', 'invalid'],
  ['sandbox', null],
  ['sandbox', 1],
  ['taskImage', ''],
  ['taskImage', ' '],
  ['taskImage', null],
  ['taskImage', 1],
  ['taskCpus', 0],
  ['taskCpus', -1],
  ['taskCpus', 64.1],
  ['taskCpus', NaN],
  ['taskCpus', Infinity],
  ['taskCpus', '2'],
  ['taskCpus', null],
  ['taskMemory', '0g'],
  ['taskMemory', '01g'],
  ['taskMemory', '1.5g'],
  ['taskMemory', '4G'],
  ['taskMemory', '4gb'],
  ['taskMemory', ''],
  ['taskMemory', null],
  ['taskMemory', 4],
  ['taskPids', 63],
  ['taskPids', 65537],
  ['taskPids', 64.5],
  ['taskPids', '64'],
  ['taskPids', null],
  ['taskPids', NaN],
  ['taskNetwork', ''],
  ['taskNetwork', ' '],
  ['taskNetwork', 1],
])('非法 %s=%s 报告字段和值', (field, value) => {
  expect(() => parseExecutorSettings({ [field as string]: value })).toThrow(
    `${field} 的值无效：${String(value)}`,
  )
})

test('codex 明确报告 M1.5 尚未实现，Docker 接受资源边界和小数 CPU', () => {
  expect(() => parseExecutorSettings({ sandbox: 'codex' })).toThrow(
    'sandbox=codex 尚未实现（M1.5）',
  )
  for (const [taskCpus, taskPids] of [
    [0.1, 64],
    [64, 65536],
  ])
    expect(
      parseExecutorSettings({
        sandbox: 'docker',
        taskCpus,
        taskPids,
        taskMemory: '512m',
        taskNetwork: 'workling',
      }),
    ).toEqual({
      ...defaults,
      sandbox: 'docker',
      taskCpus,
      taskPids,
      taskMemory: '512m',
      taskNetwork: 'workling',
    })
})

test('更新合并当前配置，忽略 undefined，支持 null 清空网络，非法修改不落库', async () => {
  const s = await database()
  const now = new Date('2026-11-15T00:00:00Z')
  try {
    const config = updateExecutorSettings(s.db, { sandbox: 'docker', taskNetwork: 'workling' }, now)
    expect(s.db.select().from(executorSettings).get()).toEqual({ id: 1, ...config, updatedAt: now })
    expect(updateExecutorSettings(s.db, { taskCpus: 1.5, sandbox: undefined })).toEqual({
      ...config,
      taskCpus: 1.5,
    })
    const before = s.db.select().from(executorSettings).get()
    expect(() => updateExecutorSettings(s.db, { taskPids: 1 })).toThrow('taskPids')
    expect(s.db.select().from(executorSettings).get()).toEqual(before)
    expect(updateExecutorSettings(s.db, { taskNetwork: null }).taskNetwork).toBeNull()
    expect(s.db.select().from(executorSettings).all()).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('首次导入环境变量并转换数字，已有行时忽略仍设置的变量且不覆盖', async () => {
  const s = await database()
  const env = {
    WORKLING_SANDBOX: 'docker',
    WORKLING_TASK_IMAGE: 'custom:tag',
    WORKLING_TASK_CPUS: '1.5',
    WORKLING_TASK_MEMORY: '512m',
    WORKLING_TASK_PIDS: '64',
    WORKLING_TASK_NETWORK: 'workling',
  }
  try {
    expect(importExecutorSettings(s.db, env)).toEqual({ imported: true, ignored: [] })
    expect(readExecutorSettings(s.db)).toEqual({
      concurrency: 3,
      sandbox: 'docker',
      taskImage: 'custom:tag',
      taskCpus: 1.5,
      taskMemory: '512m',
      taskPids: 64,
      taskNetwork: 'workling',
    })
    const before = s.db.select().from(executorSettings).get()
    expect(
      importExecutorSettings(s.db, { ...env, WORKLING_SANDBOX: '', WORKLING_TASK_CPUS: 'invalid' }),
    ).toEqual({ imported: false, ignored: Object.keys(env) })
    expect(s.db.select().from(executorSettings).get()).toEqual(before)
    expect(importExecutorSettings(s.db, {})).toEqual({ imported: false, ignored: [] })
  } finally {
    await s.dispose()
  }
})

test.each([
  ['WORKLING_SANDBOX', 'codex', 'WORKLING_SANDBOX=codex 尚未实现（M1.5）'],
  ['WORKLING_SANDBOX', 'bad', 'WORKLING_SANDBOX 的值无效：bad'],
  ['WORKLING_TASK_IMAGE', ' ', 'WORKLING_TASK_IMAGE 的值无效： '],
  ['WORKLING_TASK_CPUS', 'NaN', 'WORKLING_TASK_CPUS 的值无效：NaN'],
  ['WORKLING_TASK_CPUS', '', 'WORKLING_TASK_CPUS 的值无效：0'],
  ['WORKLING_TASK_MEMORY', '4G', 'WORKLING_TASK_MEMORY 的值无效：4G'],
  ['WORKLING_TASK_PIDS', '64.0', 'WORKLING_TASK_PIDS 的值无效：64.0'],
  ['WORKLING_TASK_PIDS', '1e3', 'WORKLING_TASK_PIDS 的值无效：1e3'],
  ['WORKLING_TASK_PIDS', '', 'WORKLING_TASK_PIDS 的值无效：'],
  ['WORKLING_TASK_PIDS', '63', 'WORKLING_TASK_PIDS 的值无效：63'],
  ['WORKLING_TASK_NETWORK', '', 'WORKLING_TASK_NETWORK 的值无效：'],
])('非法环境变量 %s 阻止导入且错误使用环境变量名', async (name, value, error) => {
  const s = await database()
  try {
    expect(() => importExecutorSettings(s.db, { [name!]: value })).toThrow(error!)
    expect(s.db.select().from(executorSettings).all()).toEqual([])
  } finally {
    await s.dispose()
  }
})

test('空环境首次导入默认值', async () => {
  const s = await database()
  try {
    expect(importExecutorSettings(s.db, {})).toEqual({ imported: true, ignored: [] })
    expect(readExecutorSettings(s.db)).toEqual(defaults)
  } finally {
    await s.dispose()
  }
})

test.each([1, 32])('并发上限接受边界 %s', (concurrency) => {
  expect(parseExecutorSettings({ concurrency }).concurrency).toBe(concurrency)
})

test('并发上限不从环境变量导入，管理页更新后持久化', async () => {
  const s = await database()
  try {
    expect(importExecutorSettings(s.db, { WORKLING_CONCURRENCY: '10' })).toEqual({
      imported: true,
      ignored: [],
    })
    expect(readExecutorSettings(s.db).concurrency).toBe(3)
    expect(updateExecutorSettings(s.db, { concurrency: 5 }).concurrency).toBe(5)
    expect(readExecutorSettings(s.db).concurrency).toBe(5)
    expect(importExecutorSettings(s.db, { WORKLING_CONCURRENCY: 'invalid' })).toEqual({
      imported: false,
      ignored: [],
    })
    expect(readExecutorSettings(s.db).concurrency).toBe(5)
  } finally {
    await s.dispose()
  }
})
