import type { Environment } from '../runtime/types.ts'

export function ghEnv(token: string, host: string): Environment {
  return { ...process.env, GH_TOKEN: token, GH_HOST: host, GH_PROMPT_DISABLED: '1' }
}
