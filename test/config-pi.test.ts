import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { piSettings } from '../src/db/schema.ts'
import {
  type PiSettings,
  importPiSettings,
  parsePiSettings,
  readPiSettings,
  updatePiSettings,
} from '../src/config/pi.ts'

const defaults: PiSettings = {
  model: 'gpt-6.1-terra',
  effort: 'medium',
  reviewModel: null,
  reviewEffort: null,
  piModel: null,
  llmBaseUrl: null,
  llmApiKey: null,
  llmApi: 'openai-responses',
  gitName: 'Workling',
  gitEmail: '359148021+workling-agent@users.noreply.github.com',
}

async function database() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-pi-settings-'))
  const { db, close } = await openDatabase(dir)
  return {
    db,
    async dispose() {
      close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('缺省字段补默认值，空表读取不写入，持久化行会重新校验', async () => {
  const s = await database()
  try {
    expect(parsePiSettings({})).toEqual(defaults)
    expect(readPiSettings(s.db)).toEqual(defaults)
    expect(s.db.select().from(piSettings).all()).toEqual([])
    updatePiSettings(s.db, {})
    s.db.update(piSettings).set({ model: ' ' }).where(eq(piSettings.id, 1)).run()
    expect(() => readPiSettings(s.db)).toThrow('model')
  } finally {
    await s.dispose()
  }
})

test.each([
  ['model', ''],
  ['model', '  '],
  ['model', null],
  ['model', 1],
  ['effort', 'max'],
  ['effort', null],
  ['effort', false],
  ['reviewEffort', 'max'],
  ['reviewModel', 1],
  ['piModel', ''],
  ['piModel', '  '],
  ['piModel', 1],
  ['llmBaseUrl', ''],
  ['llmBaseUrl', 'not a url'],
  ['llmBaseUrl', 1],
  ['llmBaseUrl', 'http://example.com'],
  ['llmBaseUrl', 'ftp://llm.example'],
  ['llmBaseUrl', 'http://localhost.example'],
  ['llmBaseUrl', 'http://[::1]'],
  ['llmApi', 'chat'],
  ['llmApi', null],
  ['llmApi', []],
  ['gitName', ' '],
  ['gitName', null],
  ['gitName', {}],
  ['gitEmail', 'invalid'],
  ['gitEmail', ''],
  ['gitEmail', 1],
])('拒绝非法 %s=%s，错误包含字段名', (field, value) => {
  expect(() => parsePiSettings({ [field as string]: value })).toThrow(field as string)
})

test('校验 LLM 地址和密钥，规范化尾部斜杠，未启用接口时丢弃 key', () => {
  for (const url of [
    'https://llm.example/v1///',
    'http://127.0.0.1:8080///',
    'http://localhost:8080',
  ]) {
    expect(parsePiSettings({ llmBaseUrl: url, llmApiKey: 'secret' })).toMatchObject({
      llmBaseUrl: url.replace(/\/+$/, ''),
      llmApiKey: 'secret',
    })
    for (const llmApiKey of [undefined, null, '', ' ', 1])
      expect(() => parsePiSettings({ llmBaseUrl: url, llmApiKey })).toThrow(
        '设置 llmBaseUrl 时必须同时设置 llmApiKey',
      )
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh'] as const)
    expect(parsePiSettings({ effort }).effort).toBe(effort)
  expect(parsePiSettings({ llmBaseUrl: null, llmApiKey: 'unused', piModel: null })).toEqual(
    defaults,
  )
})

test('首次导入环境变量，之后不覆盖并返回仍设置的变量名，包括空值', async () => {
  const s = await database()
  const env = {
    WORKLING_MODEL: 'custom',
    WORKLING_EFFORT: 'high',
    WORKLING_PI_MODEL: 'pi-custom',
    WORKLING_LLM_BASE_URL: 'https://llm.example/v1/',
    WORKLING_LLM_API_KEY: 'secret',
    WORKLING_LLM_API: 'openai-completions',
    WORKLING_GIT_NAME: 'bot',
    WORKLING_GIT_EMAIL: 'bot@example.com',
  }
  try {
    expect(importPiSettings(s.db, env)).toEqual({ imported: true, ignored: [] })
    expect(readPiSettings(s.db)).toEqual({
      model: 'custom',
      effort: 'high',
      reviewModel: null,
      reviewEffort: null,
      piModel: 'pi-custom',
      llmBaseUrl: 'https://llm.example/v1',
      llmApiKey: 'secret',
      llmApi: 'openai-completions',
      gitName: 'bot',
      gitEmail: 'bot@example.com',
    })
    const before = s.db.select().from(piSettings).get()
    expect(
      importPiSettings(s.db, { ...env, WORKLING_MODEL: '', WORKLING_EFFORT: 'invalid' }),
    ).toEqual({
      imported: false,
      ignored: Object.keys(env),
    })
    expect(s.db.select().from(piSettings).get()).toEqual(before)
    expect(importPiSettings(s.db, {})).toEqual({ imported: false, ignored: [] })
  } finally {
    await s.dispose()
  }
})

test.each([
  ['WORKLING_MODEL', ' '],
  ['WORKLING_EFFORT', 'x'],
  ['WORKLING_PI_MODEL', ''],
  ['WORKLING_LLM_BASE_URL', 'http://external.example'],
  ['WORKLING_LLM_API', 'chat'],
  ['WORKLING_GIT_NAME', ''],
  ['WORKLING_GIT_EMAIL', 'invalid'],
])('非法环境变量 %s 阻止导入且错误含变量名', async (name, value) => {
  const s = await database()
  try {
    expect(() => importPiSettings(s.db, { [name]: value })).toThrow(name)
    expect(s.db.select().from(piSettings).all()).toEqual([])
  } finally {
    await s.dispose()
  }
})

test('环境导入缺密钥时报告两个环境变量名，空环境首次写入默认值', async () => {
  const s = await database()
  try {
    expect(() => importPiSettings(s.db, { WORKLING_LLM_BASE_URL: 'https://llm.example' })).toThrow(
      '设置 WORKLING_LLM_BASE_URL 时必须同时设置 WORKLING_LLM_API_KEY',
    )
    expect(importPiSettings(s.db, {})).toEqual({ imported: true, ignored: [] })
    expect(readPiSettings(s.db)).toEqual(defaults)
  } finally {
    await s.dispose()
  }
})

test('更新合并缺省值，空 key 保留，null 清空；清空地址同时清空 key，非法修改不落库', async () => {
  const s = await database()
  const now = new Date('2026-11-14T10:30:00Z')
  try {
    const pi = updatePiSettings(
      s.db,
      {
        model: 'custom',
        piModel: 'pi-custom',
        llmBaseUrl: 'https://llm.example/',
        llmApiKey: 'secret',
      },
      now,
    )
    expect(s.db.select().from(piSettings).get()).toEqual({ id: 1, ...pi, updatedAt: now })
    expect(updatePiSettings(s.db, { effort: 'high', llmApiKey: '' })).toEqual({
      ...pi,
      effort: 'high',
    })
    expect(updatePiSettings(s.db, { model: undefined })).toEqual({ ...pi, effort: 'high' })
    expect(updatePiSettings(s.db, { piModel: null })).toMatchObject({
      piModel: null,
      llmApiKey: 'secret',
    })
    const before = s.db.select().from(piSettings).get()
    expect(() => updatePiSettings(s.db, { llmApiKey: null })).toThrow('llmApiKey')
    expect(() => updatePiSettings(s.db, { effort: 'invalid' })).toThrow('effort')
    expect(s.db.select().from(piSettings).get()).toEqual(before)
    expect(updatePiSettings(s.db, { llmBaseUrl: 'https://other.example' }).llmApiKey).toBe('secret')
    expect(updatePiSettings(s.db, { llmBaseUrl: null })).toMatchObject({
      llmBaseUrl: null,
      llmApiKey: null,
    })
    expect(updatePiSettings(s.db, { llmApiKey: null }).llmApiKey).toBeNull()
    expect(() =>
      updatePiSettings(s.db, { llmBaseUrl: 'https://llm.example', llmApiKey: '' }),
    ).toThrow('llmApiKey')
    expect(
      updatePiSettings(s.db, { llmBaseUrl: 'https://llm.example', llmApiKey: 'new-secret' })
        .llmApiKey,
    ).toBe('new-secret')
    expect(s.db.select().from(piSettings).all()).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})
