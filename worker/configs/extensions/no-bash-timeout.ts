// 命令超时由 workling 的任务级整体超时回收，避免模型填错单位导致 bash 工具拒绝执行。
import { type ExtensionAPI, isToolCallEventType } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    if (isToolCallEventType('bash', event)) delete event.input.timeout
  })
}
