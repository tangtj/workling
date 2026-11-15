import { join } from 'node:path'
import { waitProcess } from '../../src/runtime/process.ts'

await waitProcess([process.execPath, join(import.meta.dirname, 'pi.ts')], { detached: false })
