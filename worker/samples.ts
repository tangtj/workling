import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { CONTRACT_VERSION, specSchema, writeSpec, type Spec } from '../src/contract/spec.ts'
import type { Command, Environment } from './process.ts'

export const SAMPLES_DIR = resolve(import.meta.dirname, 'samples')

// 样例只描述 Issue 与仓库内容；基点由 prepare 现场提交得到，因此不写 baseRef。
const sampleSchema = Type.Object({
  kind: specSchema.properties.kind,
  issue: specSchema.properties.issue,
  branch: Type.String({ pattern: '^workling/\\d+-[a-z0-9-]+$' }),
  model: specSchema.properties.model,
  git: specSchema.properties.git,
})

export type ModelOverrides = Partial<Spec['model']>

export async function readSample(dir: string) {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(dir, 'sample.json'), 'utf8'))
  } catch (cause) {
    throw new Error(`样例 ${dir} 缺少有效的 sample.json`, { cause })
  }
  if (!Value.Check(sampleSchema, value)) throw new Error(`样例 ${dir} 的 sample.json 结构无效`)
  return value
}

/** 样例名指向 worker/samples/ 下的目录，也可以直接给出路径。 */
export function resolveSample(name: string): string {
  return /^[a-z0-9-]+$/.test(name) ? join(SAMPLES_DIR, name) : resolve(name)
}

/**
 * 把样例展开成一个可以直接 `run` 的运行目录：复制 input/，把 repo/ 提交成 Git 工作副本并检出任务分支，
 * 写入 spec.json。固定提交时间，同一样例每次得到相同的基点，便于比较不同提示词或模型的产出。
 */
export async function prepareSample({
  sample,
  dest,
  command,
  model = {},
}: {
  sample: string
  dest: string
  command: Command
  model?: ModelOverrides
}): Promise<Spec> {
  const config = await readSample(sample)
  if (await stat(dest).catch(() => null)) throw new Error(`运行目录已存在：${dest}`)
  await mkdir(dest, { recursive: true, mode: 0o700 })
  await cp(join(sample, 'input'), join(dest, 'input'), { recursive: true })
  const repo = join(dest, 'repo')
  await cp(join(sample, 'repo'), repo, { recursive: true })
  const date = '2026-01-01T00:00:00Z'
  const env: Environment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'workling-sample',
    GIT_AUTHOR_EMAIL: 'sample@workling.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'workling-sample',
    GIT_COMMITTER_EMAIL: 'sample@workling.invalid',
    GIT_COMMITTER_DATE: date,
  }
  const git = (...args: string[]) =>
    command(['git', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      env,
      quietStderr: true,
    })
  await git('init', '--quiet')
  await git('add', '--all')
  await git('commit', '--quiet', '--message', 'Sample base')
  const baseRef = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', '-b', config.branch)
  const spec: Spec = {
    contract: CONTRACT_VERSION,
    kind: config.kind,
    issue: config.issue,
    repo: { baseRef, branch: config.branch },
    model: { ...config.model, ...model },
    git: config.git,
  }
  if (!Value.Check(specSchema, spec)) throw new Error('覆盖后的模型参数无效')
  await writeSpec(dest, spec)
  return spec
}
