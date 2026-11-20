import versionJs from '../web/assets/version.js' with { type: 'text' }
import loginJs from '../web/assets/login.js' with { type: 'text' }
import styleCss from '../web/assets/style.css' with { type: 'text' }
import { createHash } from 'node:crypto'

const hash = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 12)
export const assetContents = {
  'style.css': styleCss,
  'version.js': versionJs,
  'login.js': loginJs,
}
export type AssetName = keyof typeof assetContents
export const assetHashes = Object.fromEntries(
  Object.entries(assetContents).map(([name, content]) => [name, hash(content)]),
) as Record<AssetName, string>
export const assetUrl = (name: AssetName) => `/${name}?v=${assetHashes[name]}`
