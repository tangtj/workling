// @env node
// 源自 pi-workbot（MIT），保留原作者署名。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import type { Command, Environment, ExitStatus, Launch } from './types.ts'

export const run: Command = (args, options = {}) =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['pipe', options.inherit ? 'inherit' : 'pipe', 'inherit'],
    })
    let output = ''
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const abort = (): void => {
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5_000)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      if (force) clearTimeout(force)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (options.signal?.aborted) kill('SIGKILL')
      cleanup()
      if (options.signal?.aborted) reject(new Error('进程已取消'))
      else if (code !== 0) reject(new Error(`${args[0]} 退出码 ${code}\n${output}`))
      else resolve(output.trim())
    })
  })

export async function withShutdown<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    return await action(controller.signal)
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

export const launch: Launch = (args, options) => {
  const fd = openSync(options.log, 'a')
  try {
    const child = spawn(args[0]!, args.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: options.env,
    })
    child.on('error', () => {})
    child.unref()
    if (!child.pid) throw new Error(`无法拉起进程：${args[0]}`)
    return child.pid
  } finally {
    closeSync(fd)
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return true
      if (error.code === 'ESRCH') return false
    }
    throw error
  }
}

export function isTaskAlive(pid: number, taskDir: string): boolean {
  if (!isAlive(pid)) return false
  try {
    if (process.platform === 'linux')
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').includes(taskDir)
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return result.status === 0 && result.stdout.includes(taskDir)
  } catch {
    return false
  }
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw error
  }
}

export function waitProcess(
  args: string[],
  options: { cwd?: string; env?: Environment; signal?: AbortSignal; detached?: boolean } = {},
): Promise<ExitStatus> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.detached ?? true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals): void => {
      if (options.detached === false) child.kill(signal)
      else if (child.pid) killGroup(child.pid, signal)
    }
    const abort = (): void => {
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5_000)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      if (force) clearTimeout(force)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (options.signal?.aborted) kill('SIGKILL')
      cleanup()
      resolve({ code, signal })
    })
  })
}

export function streamProcess(
  args: string[],
  options: {
    cwd?: string
    env?: Environment
    signal?: AbortSignal
    detached?: boolean
    onLine: (line: string) => void
  },
): Promise<ExitStatus> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.detached ?? true,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals): void => {
      if (options.detached === false) child.kill(signal)
      else if (child.pid) killGroup(child.pid, signal)
    }
    const abort = (): void => {
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5_000)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const decoder = new TextDecoder()
    let pending = ''
    const consume = (chunk: string): void => {
      pending += chunk
      let index: number
      while ((index = pending.indexOf('\n')) !== -1) {
        options.onLine(pending.slice(0, index).replace(/\r$/, ''))
        pending = pending.slice(index + 1)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => consume(decoder.decode(chunk, { stream: true })))
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      if (force) clearTimeout(force)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      consume(decoder.decode())
      if (pending) options.onLine(pending.replace(/\r$/, ''))
      if (options.signal?.aborted) kill('SIGKILL')
      cleanup()
      resolve({ code, signal })
    })
  })
}
