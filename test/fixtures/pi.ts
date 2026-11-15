import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const record = process.env.WORKLING_TEST_RECORD!
const child = process.env.WORKLING_TEST_SLEEP
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  : undefined
if (child) {
  process.once('SIGTERM', () => {
    child.once('exit', () => process.kill(process.pid, 'SIGTERM'))
    child.kill('SIGTERM')
  })
}
writeFileSync(
  record,
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    pid: process.pid,
    child: child?.pid,
  }),
)
if (process.env.WORKLING_TEST_EVENTS) process.stdout.write(process.env.WORKLING_TEST_EVENTS)
if (child) setInterval(() => {}, 1000)
else process.exit(Number(process.env.WORKLING_TEST_EXIT ?? 0))
