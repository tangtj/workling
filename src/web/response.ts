import { type PiSettings } from '../config/pi.ts'
import { maskToken } from './data.ts'
export function responsePi(pi: PiSettings) {
  return { ...pi, llmApiKey: pi.llmApiKey === null ? null : maskToken(pi.llmApiKey) }
}

export function repoId(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

// 页面会提交 token，禁止内联脚本和被其他页面嵌入。
export const webHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}
export const html = (content: unknown) => `<!doctype html>${String(content)}`
export const headers = { ...webHeaders, 'Content-Type': 'text/html; charset=utf-8' }
