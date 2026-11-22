import type { WebBundle } from './bundle.ts'
import { themeScript } from './theme.ts'
import { updateMode } from '../update/index.ts'

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
  // 页面里展示的运维命令随部署方式变化；Docker 部署需要经 docker compose exec 进入容器执行
  const deploy = updateMode() ? ' data-deploy="docker"' : ''
  const body = (login ? ' data-page="login" class="login"' : '') + deploy
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title><script>${themeScript}</script>${links}<script type="module" src="${escape(script)}"></script></head><body${body}><div id="root"></div></body></html>`
}
