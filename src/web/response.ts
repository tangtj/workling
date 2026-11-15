import { type PiSettings } from '../config/pi.ts'
import { createHash } from 'node:crypto'
import { maskToken } from './data.ts'
import { themeScript } from './views/theme.ts'
export function responsePi(pi: PiSettings) {
  return { ...pi, llmApiKey: pi.llmApiKey === null ? null : maskToken(pi.llmApiKey) }
}

export function repoId(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

// 页面会提交 token，只允许固定的首屏主题脚本，禁止其他内联脚本和被嵌入。
const themeHash = createHash('sha256').update(themeScript).digest('base64')
export const webHeaders = {
  'Content-Security-Policy': `default-src 'none'; script-src 'self' 'sha256-${themeHash}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}
export const html = (content: unknown) => `<!doctype html>${String(content)}`
export const headers = { ...webHeaders, 'Content-Type': 'text/html; charset=utf-8' }
