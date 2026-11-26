import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const record = process.env.WORKLING_TEST_RECORD!
const child = process.env.WORKLING_TEST_SLEEP
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  : undefined
if (child) {
  process.once('SIGTERM', () => {
    const stop = (): void => {
      process.kill(process.pid, 'SIGTERM')
    }
    // 进程组信号会同时送达子进程，它可能已先退出且 exit 事件已发出，此时直接结束。
    if (child.exitCode !== null || child.signalCode !== null) return stop()
    child.once('exit', stop)
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
if (process.env.WORKLING_TEST_REVIEW !== undefined)
  writeFileSync(join(dirname(record), 'out/review.json'), process.env.WORKLING_TEST_REVIEW)
const out = join(dirname(record), 'out')
if (process.env.WORKLING_TEST_PLAN !== undefined)
  writeFileSync(join(out, 'plan.json'), process.env.WORKLING_TEST_PLAN)
if (process.env.WORKLING_TEST_OUTCOME !== undefined)
  writeFileSync(
    join(out, 'outcome.json'),
    JSON.stringify({ outcome: process.env.WORKLING_TEST_OUTCOME }),
  )

const planDoc = process.env.WORKLING_TEST_PLAN_DOC
if (planDoc) {
  mkdirSync(dirname(planDoc), { recursive: true })
  writeFileSync(planDoc, '# Design\n')
  execFileSync('git', ['add', '--', planDoc])
}
if (planDoc || process.env.WORKLING_TEST_REVIEW_COMMIT)
  execFileSync('git', [
    '-c',
    'user.name=Pi fixture',
    '-c',
    'user.email=pi@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '--message',
    planDoc ? 'Add design document' : 'Unexpected review commit',
  ])
if (child) setInterval(() => {}, 1000)
else process.exit(Number(process.env.WORKLING_TEST_EXIT ?? 0))
