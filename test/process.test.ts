import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { run, withShutdown } from '../src/runtime/process.ts'

const canInspectProcess = (() => {
  if (process.platform === 'linux') return true
  try {
    return spawnSync('ps', ['-o', 'command=', '-p', String(process.pid)]).status === 0
  } catch {
    return false
  }
})()

describe('子进程运行时', () => {
  test('stdin 传递完整 UTF-8 正文', async () => {
    const body = '第一行：你好\n第二行：世界 🌏'
    await expect(
      run([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { input: body }),
    ).resolves.toBe(body)
  })

  test('非零退出码包含错误输出', async () => {
    await expect(
      run([process.execPath, '-e', "console.log('检查失败'); process.exit(7)"]),
    ).rejects.toThrow(/退出码 7\n检查失败/)
  })

  test('启动不存在的命令时拒绝', async () => {
    await expect(run(['/definitely/not/a/real/command'])).rejects.toThrow()
  })

  test('取消信号终止子进程', async () => {
    const controller = new AbortController()
    const pending = run([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/进程已取消/)
  })

  test('withShutdown 返回 action 的结果', async () => {
    await expect(withShutdown(async () => '完成')).resolves.toBe('完成')
  })
})

test('waitProcess 返回非零退出码且仅启动失败 reject', async () => {
  const { waitProcess } = await import('../src/runtime/process.ts')
  expect(await waitProcess([process.execPath, '-e', 'process.exit(7)'])).toEqual({
    code: 7,
    signal: null,
  })
  await expect(waitProcess(['/definitely/not/a/real/command'])).rejects.toThrow()
})

test.skipIf(!canInspectProcess)('isTaskAlive 校验真实进程的任务目录并识别已退出进程', async () => {
  const { isTaskAlive } = await import('../src/runtime/process.ts')
  const dir = '/tmp/workling-task-alive-test'
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', dir])
  try {
    // spawn 返回时子进程可能尚未完成 exec，/proc/<pid>/cmdline 仍是父进程的命令行。
    for (let i = 0; i < 100 && !isTaskAlive(child.pid, dir); i++) await Bun.sleep(20)
    expect(isTaskAlive(child.pid, dir)).toBe(true)
    expect(isTaskAlive(child.pid, `${dir}-other`)).toBe(false)
  } finally {
    child.kill()
    await child.exited
  }
  expect(isTaskAlive(child.pid, dir)).toBe(false)
})

test('launch 立即返回、追加日志且启动者退出不等待，killGroup 结束整组并忽略不存在 pid', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { isAlive, killGroup, launch } = await import('../src/runtime/process.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-process-'))
  const log = join(dir, 'task.log')
  const record = join(dir, 'pi.json')
  let pid: number | undefined
  try {
    // 独立启动者应在其长驻子进程之前退出。
    const starter = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { launch } from ${JSON.stringify(resolve('src/runtime/process.ts'))}; console.log(launch(${JSON.stringify([process.execPath, resolve('test/fixtures/pi.ts')])}, { env: process.env, log: ${JSON.stringify(log)} }))`,
      ],
      {
        env: { ...process.env, WORKLING_TEST_RECORD: record, WORKLING_TEST_SLEEP: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await Promise.race([starter.exited, Bun.sleep(3000).then(() => 'timeout')])).toBe(0)
    pid = Number((await new Response(starter.stdout).text()).trim())
    expect(pid).toBeGreaterThan(0)
    for (let i = 0; !(await Bun.file(record).exists()) && i < 200; i++) await Bun.sleep(20)
    const captured = JSON.parse(await readFile(record, 'utf8'))
    expect(isAlive(pid)).toBe(true)
    expect(isAlive(captured.child)).toBe(true)
    killGroup(pid, 'SIGTERM')
    for (let i = 0; (isAlive(pid) || isAlive(captured.child)) && i < 200; i++) await Bun.sleep(20)
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(captured.child)).toBe(false)
    const writer = launch([process.execPath, '-e', "console.log('out'); console.error('err')"], {
      env: process.env,
      log,
    })
    for (let i = 0; isAlive(writer) && i < 200; i++) await Bun.sleep(20)
    expect(isAlive(writer)).toBe(false)
    expect(await readFile(log, 'utf8')).toContain('out\nerr\n')
    const second = launch([process.execPath, '-e', "console.log('appended')"], {
      env: process.env,
      log,
    })
    for (let i = 0; isAlive(second) && i < 200; i++) await Bun.sleep(20)
    expect(await readFile(log, 'utf8')).toContain('out\nerr\nappended\n')
    expect(() => killGroup(pid!, 'SIGTERM')).not.toThrow()
    expect(() => launch(['/definitely/not/a/real/command'], { env: {}, log })).toThrow()
  } finally {
    if (pid) killGroup(pid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('waitProcess 在 SIGTERM 被忽略时升级 SIGKILL', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { waitProcess } = await import('../src/runtime/process.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-force-'))
  const ready = join(dir, 'ready')
  const controller = new AbortController()
  const pending = waitProcess(
    [
      process.execPath,
      '-e',
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`,
    ],
    { signal: controller.signal },
  )
  try {
    for (let i = 0; !(await Bun.file(ready).exists()) && i < 200; i++) await Bun.sleep(20)
    expect(await Bun.file(ready).exists()).toBe(true)
    controller.abort()
    expect(await pending).toEqual({ code: null, signal: 'SIGKILL' })
  } finally {
    controller.abort()
    await pending
    await rm(dir, { recursive: true, force: true })
  }
}, 10000)

test('task 进程组收到 SIGKILL 时，同组假 Pi 在两秒内结束', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { isAlive, killGroup, launch } = await import('../src/runtime/process.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-task-group-'))
  const record = join(dir, 'pi.json')
  const pid = launch([process.execPath, resolve('test/fixtures/task-process.ts')], {
    env: { ...process.env, WORKLING_TEST_RECORD: record, WORKLING_TEST_SLEEP: '1' },
    log: join(dir, 'task.log'),
  })
  let pi: { pid: number; child: number } | undefined
  try {
    for (let i = 0; !(await Bun.file(record).exists()) && i < 100; i++) await Bun.sleep(20)
    expect(await Bun.file(record).exists()).toBe(true)
    pi = JSON.parse(await readFile(record, 'utf8'))
    expect(isAlive(pi!.pid)).toBe(true)
    killGroup(pid, 'SIGKILL')
    const deadline = performance.now() + 2000
    while (isAlive(pi!.pid) && performance.now() < deadline) await Bun.sleep(10)
    expect(isAlive(pi!.pid)).toBe(false)
  } finally {
    killGroup(pid, 'SIGKILL')
    for (const child of pi ? [pi.pid, pi.child] : []) {
      if (isAlive(child)) process.kill(child, 'SIGKILL')
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('streamProcess 处理 UTF-8 分块、LF、CRLF 和末尾残留并返回退出码', async () => {
  const { streamProcess } = await import('../worker/process.ts')
  const lines: string[] = []
  const script = String.raw`const b = Buffer.from('甲\u2028乙\r\n丙\n尾'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1, 8)); setTimeout(() => { process.stdout.write(b.subarray(8)); process.exitCode = 7 }, 10) }, 10)`
  expect(
    await streamProcess([process.execPath, '-e', script], { onLine: (line) => lines.push(line) }),
  ).toEqual({ code: 7, signal: null })
  expect(lines).toEqual(['甲\u2028乙', '丙', '尾'])
})

test('streamProcess 中止时结束进程组', async () => {
  const { streamProcess } = await import('../worker/process.ts')
  const controller = new AbortController()
  const pending = streamProcess(
    [process.execPath, '-e', "console.log('ready'); setInterval(() => {}, 1000)"],
    { signal: controller.signal, onLine: () => controller.abort() },
  )
  expect(await pending).toEqual({ code: null, signal: 'SIGTERM' })
})
