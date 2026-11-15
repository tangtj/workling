import type { WebBundle } from '../bundle.ts'
import { themeScript } from './theme.ts'

export function Shell({ script, styles }: WebBundle) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>Workling</title>
        <script dangerouslySetInnerHTML={{ __html: themeScript }}></script>
        {styles.map((href) => (
          <link rel="stylesheet" href={href} />
        ))}
        <script type="module" src={script}></script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  )
}
