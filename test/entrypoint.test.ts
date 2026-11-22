import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../src/runtime/paths.ts'
import { readState, writeState } from '../src/update/state.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture(imageVersion = 'v0.1.0', installed = 'v0.2.0') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'workling-entrypoint-')))
  dirs.push(dir)
  const appHome = join(dir, 'app'),
    imageRoot = join(dir, 'image'),
    data = join(dir, 'data')
  const target = join(appHome, 'releases', installed)
  for (const root of [imageRoot, target]) {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/cli.ts'), '')
    await writeFile(join(root, 'VERSION'), root === imageRoot ? imageVersion : installed)
  }
  await mkdir(join(imageRoot, 'src/runtime'), { recursive: true })
  for (const file of ['version.ts', 'paths.ts'])
    await copyFile(join(ROOT, 'src/runtime', file), join(imageRoot, 'src/runtime', file))
  await mkdir(join(data, 'backups'), { recursive: true })
  await symlink(target, join(appHome, 'current'))
  const backup = join(data, 'backups/workling-before.db')
  await writeFile(backup, 'before')
  await writeFile(join(data, 'workling.db'), 'after')
  const execute = async () => {
    const proc = Bun.spawn(['bash', join(ROOT, 'deploy/docker/entrypoint.sh')], {
      env: {
        ...process.env,
        APP_HOME: appHome,
        IMAGE_ROOT: imageRoot,
        WORKLING_DATA: data,
        WORKLING_EXEC:
          'pwd -P; cat "$WORKLING_DATA/workling.db"; printf "\\n%s\\n" "$WORKLING_APP_HOME"',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  }
  const state = {
    current: installed,
    previous: imageVersion,
    previousIsImage: true,
    backup,
    pending: true,
    attempts: 0,
    updatedAt: new Date().toISOString(),
  }
  return { dir, appHome, imageRoot, target, data, backup, state, execute }
}

test('镜像版本更高时使用镜像代码并清除 current 与 pending，遗留锁被清理', async () => {
  const f = await fixture('v0.10.0', 'v0.9.1')
  writeState(f.appHome, f.state)
  await writeFile(join(f.appHome, 'update.lock'), 'stale')
  const result = await f.execute()
  expect(result.code).toBe(0)
  expect(result.stdout.split('\n')[0]).toBe(f.imageRoot)
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
  expect(readState(f.appHome)).toMatchObject({ current: null, pending: false, attempts: 0 })
  expect(existsSync(join(f.appHome, 'update.lock'))).toBe(false)
})

test('current 更高时运行卷内代码，记录启动尝试，dev 最小并按预发布优先级比较', async () => {
  for (const [image, installed] of [
    ['v0.9.1', 'v0.10.0-rc.1'],
    ['dev', 'v0.0.1'],
    ['v1.0.0-rc.2', 'v1.0.0-rc.10'],
    ['v1.0.0-rc.10', 'v1.0.0'],
  ]) {
    const f = await fixture(image, installed)
    writeState(f.appHome, f.state)
    const result = await f.execute()
    expect(result.code).toBe(0)
    expect(result.stdout.split('\n')[0]).toBe(f.target)
    expect(result.stdout).toContain(f.appHome)
    expect(readState(f.appHome)?.attempts).toBe(1)
  }
})

test('pending 连续三次未健康，第四次启动前自动回滚镜像并恢复数据库', async () => {
  const f = await fixture()
  writeState(f.appHome, { ...f.state, updatedAt: '2026-01-01T00:00:00.000Z' })
  for (let i = 1; i <= 3; i++) {
    expect((await f.execute()).code).toBe(0)
    expect(readState(f.appHome)?.attempts).toBe(i)
  }
  await writeFile(join(f.data, 'workling.db-wal'), 'wal')
  await writeFile(join(f.data, 'workling.db-shm'), 'shm')
  const result = await f.execute()
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('before')
  expect(result.stdout.split('\n')[0]).toBe(f.imageRoot)
  expect(readState(f.appHome)).toMatchObject({
    current: 'v0.1.0',
    previous: null,
    pending: false,
    attempts: 0,
    lastError: '新版本连续 3 次启动失败，已自动回滚',
  })
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
  expect(Date.parse(readState(f.appHome)!.updatedAt)).toBeGreaterThan(
    Date.parse('2026-01-01T00:00:00.000Z'),
  )
  expect(existsSync(join(f.data, 'workling.db-wal'))).toBe(false)
  expect(existsSync(join(f.data, 'workling.db-shm'))).toBe(false)
})

test('自动回滚可切回卷内上一版本', async () => {
  const f = await fixture('v0.1.0', 'v0.3.0')
  const previous = join(f.appHome, 'releases/v0.2.0')
  await mkdir(join(previous, 'src'), { recursive: true })
  await writeFile(join(previous, 'src/cli.ts'), '')
  await writeFile(join(previous, 'VERSION'), 'v0.2.0')
  writeState(f.appHome, { ...f.state, previous: 'v0.2.0', previousIsImage: false, attempts: 3 })
  const result = await f.execute()
  expect(result.code).toBe(0)
  expect(result.stdout.split('\n')[0]).toBe(previous)
  expect(await readlink(join(f.appHome, 'current'))).toBe(previous)
  expect(readState(f.appHome)?.current).toBe('v0.2.0')
})

test('自动回滚的备份缺失时退出，不启动服务且不切换 current', async () => {
  const f = await fixture()
  writeState(f.appHome, { ...f.state, attempts: 3, backup: join(f.data, 'backups/missing.db') })
  const result = await f.execute()
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(await readlink(join(f.appHome, 'current'))).toBe(f.target)
  expect(readState(f.appHome)).toMatchObject({ current: 'v0.2.0', pending: true, attempts: 4 })
  expect(await readFile(join(f.data, 'workling.db'), 'utf8')).toBe('after')
})

test('entrypoint 接受并保留 lastSuccess，启动在线版本与自动回滚写回也不丢失', async () => {
  const lastSuccess = { tag: 'v0.1.0', at: '2026-11-14T00:00:00.000Z' }
  for (const [image, installed, attempts] of [
    ['v0.1.0', 'v0.2.0', 0],
    ['v0.1.0', 'v0.2.0', 3],
  ] as const) {
    const f = await fixture(image, installed)
    writeState(f.appHome, { ...f.state, attempts, lastSuccess })
    const result = await f.execute()
    expect(result.code).toBe(0)
    expect(readState(f.appHome)?.lastSuccess).toEqual(lastSuccess)
  }
})

test('entrypoint 拒绝无效 lastSuccess 形状', async () => {
  const f = await fixture()
  for (const lastSuccess of [
    null,
    { tag: '../bad', at: '' },
    { tag: 'v0.1.0', at: 1 },
    { tag: 'v0.1.0', at: '', extra: true },
  ]) {
    await writeFile(join(f.appHome, 'state.json'), JSON.stringify({ ...f.state, lastSuccess }))
    const result = await f.execute()
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('更新状态文件格式无效')
  }
})

test('同一版本正式镜像优先于预发布在线代码', async () => {
  const f = await fixture('v1.0.0', 'v1.0.0-rc.10')
  writeState(f.appHome, f.state)
  expect((await f.execute()).stdout.split('\n')[0]).toBe(f.imageRoot)
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
})

test('镜像版本更高时清除过期 lastError 与 lastSuccess，并刷新 updatedAt', async () => {
  const f = await fixture('v0.3.0', 'v0.2.0')
  const updatedAt = '2026-01-01T00:00:00.000Z'
  writeState(f.appHome, {
    ...f.state,
    updatedAt,
    lastError: '旧在线版本更新失败',
    lastSuccess: { tag: 'v0.2.0', at: updatedAt },
  })
  const result = await f.execute()
  expect(result.code).toBe(0)
  expect(result.stdout.split('\n')[0]).toBe(f.imageRoot)
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
  const state = readState(f.appHome)!
  expect(state.current).toBeNull()
  expect(state).not.toHaveProperty('lastError')
  expect(state).not.toHaveProperty('lastSuccess')
  expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.parse(updatedAt))
})

test('edge 仅在镜像版本匹配记录时启用，否则清除 current', async () => {
  for (const matches of [true, false]) {
    const f = await fixture('v1.0.0', 'edge-012345abcdef')
    writeState(f.appHome, { ...f.state, image: matches ? 'v1.0.0' : 'v0.9.0' })
    const result = await f.execute()
    expect(result.code).toBe(0)
    expect(result.stdout.split('\n')[0]).toBe(matches ? f.target : f.imageRoot)
    expect(existsSync(join(f.appHome, 'current'))).toBe(matches)
  }
})
