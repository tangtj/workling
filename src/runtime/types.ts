// @env node
export type Environment = Record<string, string | undefined>

export interface RunOptions {
  cwd?: string
  env?: Environment
  input?: string
  signal?: AbortSignal
  inherit?: boolean
}

export type Command = (args: string[], options?: RunOptions) => Promise<string>

export type Launch = (args: string[], options: { env: Environment; log: string }) => number

export interface ExitStatus {
  code: number | null
  signal: NodeJS.Signals | null
}
