import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { ROOT } from '../src/runtime/paths.ts'

// worker 与主体只通过 src/contract/ 交互，worker 才能单独打包、单独发布。
async function imports(dir: string) {
  const result: { file: string; target: string }[] = []
  for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan(join(ROOT, dir))) {
    const path = join(ROOT, dir, file)
    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm,
    ))
      result.push({
        file: relative(ROOT, path),
        target: relative(ROOT, resolve(dirname(path), match[1]!)),
      })
  }
  return result
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

test('worker 只引用自身与 src/contract/', async () => {
  const violations = (await imports('worker')).filter(
    ({ target }) => !inside(target, 'worker') && !inside(target, 'src/contract'),
  )
  expect(violations).toEqual([])
})

test('src/contract/ 不依赖主体或 worker 的其他代码', async () => {
  const violations = (await imports('src/contract')).filter(
    ({ target }) => !inside(target, 'src/contract'),
  )
  expect(violations).toEqual([])
})

test('主体代码不引用 worker/', async () => {
  const violations = (await imports('src')).filter(({ target }) => inside(target, 'worker'))
  expect(violations).toEqual([])
})
