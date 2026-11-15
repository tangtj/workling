import { expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { readSettings } from '../src/config/env.ts'

const taskDefaults = {
  timeout: 90,
  keepRuns: 5,
}

test('未设置时使用默认配置', () => {
  expect(readSettings({})).toEqual({
    ...taskDefaults,
    workspace: resolve(process.cwd(), '.runtime'),
    worker: hostname(),
    port: 7420,
    interval: 60,
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost', '::1'],
    secureCookie: false,
  })
})
test('读取自定义工作区、端口、间隔和管理接口设置', () => {
  expect(
    readSettings({
      WORKLING_WORKSPACE: 'work',
      WORKLING_WORKER: 'worker-test',
      WORKLING_PORT: '0',
      WORKLING_INTERVAL: '5',
      WORKLING_HOST: '0.0.0.0',
      WORKLING_ALLOWED_HOSTS: ' Workling.Example.com, ,admin.example.com ',
      WORKLING_SECURE_COOKIE: 'true',
    }),
  ).toEqual({
    ...taskDefaults,
    workspace: resolve('work'),
    worker: 'worker-test',
    port: 0,
    interval: 5,
    host: '0.0.0.0',
    allowedHosts: ['127.0.0.1', 'localhost', '::1', 'workling.example.com', 'admin.example.com'],
    secureCookie: true,
  })
})
test.each([
  { WORKLING_PORT: '-1' },
  { WORKLING_PORT: '65536' },
  { WORKLING_PORT: '1.5' },
  { WORKLING_INTERVAL: '4' },
  { WORKLING_INTERVAL: 'x' },
])('拒绝非法端口或间隔 %s', (env) => {
  expect(() => readSettings(env)).toThrow(Object.keys(env)[0]!)
})

test('拒绝空监听地址和非法 Secure Cookie 值', () => {
  expect(() => readSettings({ WORKLING_HOST: ' ' })).toThrow('WORKLING_HOST')
  expect(() => readSettings({ WORKLING_SECURE_COOKIE: 'yes' })).toThrow(
    'WORKLING_SECURE_COOKIE 的值无效：yes',
  )
})

test.each([1, 1440])('任务超时接受边界 %s', (timeout) => {
  expect(readSettings({ WORKLING_TIMEOUT: String(timeout) })).toMatchObject({ timeout })
})

test.each([
  ['WORKLING_TIMEOUT', '0'],
  ['WORKLING_TIMEOUT', '1441'],
  ['WORKLING_TIMEOUT', '1.5'],
  ['WORKLING_TIMEOUT', 'x'],
])('任务配置拒绝 %s=%s 并输出规定错误', (name, value) => {
  expect(() => readSettings({ [name!]: value })).toThrow(`${name} 的值无效：${value}`)
})

test('保留次数接受边界并拒绝非法值', () => {
  for (const value of [1, 100])
    expect(readSettings({ WORKLING_KEEP_RUNS: String(value) }).keepRuns).toBe(value)
  for (const value of ['0', '101', '1.5', ''])
    expect(() => readSettings({ WORKLING_KEEP_RUNS: value })).toThrow(
      `WORKLING_KEEP_RUNS 的值无效：${value}`,
    )
})
