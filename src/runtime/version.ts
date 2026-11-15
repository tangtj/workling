import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.ts'

export function readVersion(root = ROOT): string {
  try {
    return readFileSync(join(root, 'VERSION'), 'utf8').trim() || 'dev'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'dev'
    throw error
  }
}

export const TAG_PATTERN = '^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$'
export const validTag = (tag: string): boolean => new RegExp(TAG_PATTERN).test(tag)

export const isPrerelease = (tag: string): boolean => tag.split('+')[0]!.includes('-')

export function compareVersions(a: string, b: string): number {
  if (a === 'dev' || b === 'dev') return a === b ? 0 : a === 'dev' ? -1 : 1
  const parts = (version: string) => {
    const withoutBuild = version.replace(/^v/, '').split('+')[0]!
    const separator = withoutBuild.indexOf('-')
    return {
      core: (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator))
        .split('.')
        .map(BigInt),
      pre: separator < 0 ? undefined : withoutBuild.slice(separator + 1),
    }
  }
  const { core: left, pre: preLeft } = parts(a)
  const { core: right, pre: preRight } = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0n) - (right[i] ?? 0n)
    if (delta !== 0n) return delta > 0n ? 1 : -1
  }
  if (preLeft === undefined || preRight === undefined)
    return preLeft === preRight ? 0 : preLeft === undefined ? 1 : -1
  const x = preLeft.split('.')
  const y = preRight.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i],
      r = y[i]
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1
    if (l === r) continue
    const numericLeft = /^[0-9]+$/.test(l),
      numericRight = /^[0-9]+$/.test(r)
    if (numericLeft && numericRight) {
      if (BigInt(l) !== BigInt(r)) return BigInt(l) > BigInt(r) ? 1 : -1
    } else if (numericLeft !== numericRight) return numericLeft ? -1 : 1
    else return l > r ? 1 : -1
  }
  return 0
}
