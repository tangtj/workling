import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeOutResult } from '../../src/contract/out.ts'

export const tip = 'b'.repeat(40)

export async function writeDeliveryFixture(dir: string, branch: string) {
  const out = join(dir, 'out')
  await mkdir(out)
  await writeFile(join(out, 'commits.bundle'), 'fixture bundle for Git command stub')
  await writeFile(join(out, 'pr-body.md'), 'fixture body')
  await writeOutResult(out, { contract: 2, outcome: 'completed', branch, head: tip, commits: 1 })
}
