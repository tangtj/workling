import { basename } from 'node:path'

export type WebBundle = {
  files: Map<string, { body: Uint8Array; type: string }>
  script: string
  loginScript: string
  loginStyles: string[]
  styles: string[]
}

export async function buildWebBundle(): Promise<WebBundle> {
  const result = await Bun.build({
    entrypoints: [
      new URL('./client/main.tsx', import.meta.url).pathname,
      new URL('./client/login.tsx', import.meta.url).pathname,
    ],
    target: 'browser',
    throw: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    naming: '[name]-[hash].[ext]',
    splitting: false,
  })
  if (!result.success) throw new Error(`Web 打包失败：\n${result.logs.join('\n')}`)
  const files: WebBundle['files'] = new Map()
  let script = ''
  let loginScript = ''
  const styles: string[] = []
  const loginStyles: string[] = []
  for (const artifact of result.outputs) {
    const path = `/assets/${basename(artifact.path)}`
    files.set(path, {
      body: new Uint8Array(await artifact.arrayBuffer()),
      type: artifact.type,
    })
    if (artifact.kind === 'entry-point' && path.endsWith('.js')) {
      if (basename(artifact.path).startsWith('login-')) loginScript = path
      else if (basename(artifact.path).startsWith('main-')) script = path
    }
    if (path.endsWith('.css')) {
      if (basename(artifact.path).startsWith('login-')) loginStyles.push(path)
      else styles.push(path)
    }
  }
  if (!script || !loginScript) throw new Error('Web 打包缺少 JS 入口')
  return { files, script, loginScript, styles, loginStyles }
}

let bundle: Promise<WebBundle> | undefined
export const getWebBundle = () => (bundle ??= buildWebBundle())
