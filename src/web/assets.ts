import timelineJs from '../web/assets/timeline.js?text' with { type: 'text' }
import runLogJs from '../web/assets/run-log.js' with { type: 'text' }
import versionJs from '../web/assets/version.js' with { type: 'text' }
import appJs from '../web/assets/app.js' with { type: 'text' }
import loginJs from '../web/assets/login.js' with { type: 'text' }
import styleCss from '../web/assets/style.css' with { type: 'text' }
import { createHash } from 'node:crypto'

const hash = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 12)
const timelineHash = hash(timelineJs)
const timelineImport = "from '/timeline.js'"
if (!runLogJs.includes(timelineImport)) throw new Error('Missing timeline import in run-log.js')

export const assetContents = {
  'style.css': styleCss,
  'app.js': appJs,
  'version.js': versionJs,
  'timeline.js': timelineJs,
  'run-log.js': runLogJs.replace(timelineImport, `from '/timeline.js?v=${timelineHash}'`),
  'login.js': loginJs,
}
export type AssetName = keyof typeof assetContents
export const assetHashes = Object.fromEntries(
  Object.entries(assetContents).map(([name, content]) => [
    name,
    name === 'timeline.js' ? timelineHash : hash(content),
  ]),
) as Record<AssetName, string>
export const assetUrl = (name: AssetName) => `/${name}?v=${assetHashes[name]}`
