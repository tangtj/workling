// @env node
import { afterEach, beforeEach, mock } from 'bun:test'
import { clearDefaultBranchCache } from '../src/platform/github.ts'
import { clearReconcileFailures } from '../src/serve/reconcile.ts'

const original = { ...process.env }

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(WORKLING_|PI_|GITHUB_|GH_|GITLAB_|GLAB_|CI_|OPENAI_|ANTHROPIC_|CODEX_)/.test(key))
      delete process.env[key]
  }
})

afterEach(() => {
  clearDefaultBranchCache()
  clearReconcileFailures()
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})
