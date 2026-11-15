// @env node
import { afterEach, beforeEach, mock } from 'bun:test'

const original = { ...process.env }

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(WORKLING_|PI_|GITHUB_|GH_|GITLAB_|GLAB_|CI_|OPENAI_|ANTHROPIC_|CODEX_)/.test(key))
      delete process.env[key]
  }
})

afterEach(() => {
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})
