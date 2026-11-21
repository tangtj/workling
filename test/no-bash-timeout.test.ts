import { expect, test } from 'bun:test'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import noBashTimeout from '../worker/configs/extensions/no-bash-timeout.ts'

test('扩展移除 bash timeout，保留其他输入和工具调用且不阻止执行', async () => {
  let handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined
  const pi = {
    on(name: string, callback: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) {
      expect(name).toBe('tool_call')
      handler = callback
    },
  }
  noBashTimeout(pi as unknown as ExtensionAPI)
  expect(handler).toBeDefined()

  const bash: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'bash-1',
    toolName: 'bash',
    input: { command: 'echo', timeout: 5400000 },
  }
  expect(await handler!(bash, {} as ExtensionContext)).toBeUndefined()
  expect(bash.input).toEqual({ command: 'echo' })

  const read: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'read-1',
    toolName: 'read',
    input: { path: 'example', timeout: 5400000 },
  }
  expect(await handler!(read, {} as ExtensionContext)).toBeUndefined()
  expect(read.input).toEqual({ path: 'example', timeout: 5400000 })
})
