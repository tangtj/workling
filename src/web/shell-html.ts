import type { WebBundle } from './bundle.ts'
import { themeScript } from './theme.ts'

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
}

export function shellHtml(bundle: WebBundle, login = false) {
  const title = login ? '登录 · Workling' : 'Workling'
  const styles = login ? bundle.loginStyles : bundle.styles
  const script = login ? bundle.loginScript : bundle.script
  const links = styles.map((href) => `<link rel="stylesheet" href="${escape(href)}">`).join('')
  const body = login ? ' data-page="login" class="login"' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title><script>${themeScript}</script>${links}<script type="module" src="${escape(script)}"></script></head><body${body}><div id="root"></div></body></html>`
}
