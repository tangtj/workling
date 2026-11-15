import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Environment } from '../runtime/types.ts'

export function readSettings(env: Environment = process.env) {
  const host = env.WORKLING_HOST ?? '127.0.0.1'
  if (!host.trim()) throw new Error('WORKLING_HOST 的值无效：')
  const secureCookie = env.WORKLING_SECURE_COOKIE
  if (secureCookie !== undefined && secureCookie !== 'true' && secureCookie !== 'false')
    throw new Error(`WORKLING_SECURE_COOKIE 的值无效：${secureCookie}`)
  const allowedHosts = [
    '127.0.0.1',
    'localhost',
    '::1',
    ...(env.WORKLING_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ]
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name]
    if (value === undefined) return fallback
    const number = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`${name} 的值无效：${value}`)
    return number
  }
  return {
    // 默认放在启动目录下，相对路径也按启动目录解析；task 子进程由 watch 显式传入绝对路径。
    workspace: resolve(process.cwd(), env.WORKLING_WORKSPACE ?? '.runtime'),
    worker: env.WORKLING_WORKER ?? hostname(),
    port: integer('WORKLING_PORT', 7420, 0, 65535),
    interval: integer('WORKLING_INTERVAL', 60, 5, Number.MAX_SAFE_INTEGER),
    timeout: integer('WORKLING_TIMEOUT', 90, 1, 1440),
    keepRuns: integer('WORKLING_KEEP_RUNS', 5, 1, 100),
    host,
    allowedHosts: [...new Set(allowedHosts)],
    secureCookie: secureCookie === 'true',
  }
}

export type Settings = ReturnType<typeof readSettings>
