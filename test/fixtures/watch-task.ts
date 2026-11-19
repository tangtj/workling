import { writeResult } from '../../src/task/dir.ts'
import { readSpec } from '../../src/contract/spec.ts'
import { writeDeliveryFixture } from '../helpers/delivery.ts'

const dir = process.argv[2]!
await writeDeliveryFixture(dir, (await readSpec(dir)).repo.branch)
await writeResult(dir, {
  exitCode: 0,
  signal: null,
  finishedAt: new Date().toISOString(),
})
