import { writeResult } from '../../src/task/dir.ts'

await writeResult(process.argv[2]!, {
  exitCode: 0,
  signal: null,
  finishedAt: new Date().toISOString(),
})
