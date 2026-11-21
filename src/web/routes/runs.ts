import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { runs } from '../../db/schema.ts'
import { open, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { assertTaskDir } from '../../contract/result.ts'
import { redact } from '../../contract/report.ts'

import type { AppDeps } from '../app.ts'
import { repoId } from '../response.ts'

export function runsRoutes(deps: AppDeps): Hono {
  const { db, options } = deps
  const app = new Hono()
  app.get('/api/runs/:id/events', async (c) => {
    const id = repoId(c.req.param('id'))
    const row = id ? db.select().from(runs).where(eq(runs.id, id)).get() : undefined
    if (!row) return c.json({ error: '执行记录不存在' }, 404)
    const offsets = [c.req.query('workling') ?? '0', c.req.query('pi') ?? '0']
    if (offsets.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))
      return c.json({ error: 'offset 无效' }, 400)
    let dir: string
    try {
      if (!row.taskDir) throw new Error('日志已清理')
      dir = assertTaskDir(options.workspace, row.taskDir)
      await stat(dir)
    } catch {
      return c.json({ error: '日志已清理' }, 404)
    }
    const secrets = options.secrets?.() ?? []
    const readLines = async (name: string, offset: number) => {
      let file
      try {
        file = await open(join(dir, name), 'r')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return { offset, lines: [] }
        throw error
      }
      try {
        const size = (await file.stat()).size
        const buffer = Buffer.alloc(Math.min(Math.max(size - offset, 0), 1024 * 1024))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        const complete = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1
        if (complete === 0 && bytesRead === 1024 * 1024) {
          let scanned = bytesRead
          while (offset + scanned < size) {
            const chunk = Buffer.alloc(Math.min(1024 * 1024, size - offset - scanned))
            const read = await file.read(chunk, 0, chunk.length, offset + scanned)
            if (read.bytesRead === 0) break
            const newline = chunk.subarray(0, read.bytesRead).indexOf(10)
            if (newline !== -1) {
              const bytes = scanned + newline
              return {
                offset: offset + bytes + 1,
                lines: [JSON.stringify({ type: 'oversized_line', bytes })],
              }
            }
            scanned += read.bytesRead
          }
        }
        return {
          offset: offset + complete,
          lines:
            complete === 0
              ? []
              : buffer
                  .subarray(0, complete - 1)
                  .toString('utf8')
                  .split('\n')
                  .map((line) => redact(line.replace(/\r$/, ''), secrets)),
        }
      } finally {
        await file.close()
      }
    }
    const workling = await readLines('workling-events.jsonl', Number(offsets[0]))
    const pi = await readLines('pi-events.jsonl', Number(offsets[1]))
    let fallback: { lines: string[] } | null = null
    if (
      offsets.every((offset) => Number(offset) === 0) &&
      !(await Bun.file(join(dir, 'workling-events.jsonl')).exists())
    ) {
      let hasEvents = false
      const piPath = join(dir, 'pi-events.jsonl')
      if (await Bun.file(piPath).exists()) {
        const input = createReadStream(piPath)
        const lines = createInterface({ input, crlfDelay: Infinity })
        try {
          for await (const line of lines) {
            try {
              const event: unknown = JSON.parse(line)
              if (
                Value.Check(Type.Object({ type: Type.String() }), event) &&
                event.type !== 'session'
              ) {
                hasEvents = true
                break
              }
            } catch {
              /* 非 JSON 输出不算结构化事件。 */
            }
          }
        } finally {
          lines.close()
          input.destroy()
        }
      }
      if (!hasEvents) {
        try {
          const file = await open(join(dir, 'task.log'), 'r')
          try {
            const size = (await file.stat()).size
            const buffer = Buffer.alloc(Math.min(size, 1024 * 1024))
            const { bytesRead } = await file.read(
              buffer,
              0,
              buffer.length,
              Math.max(0, size - buffer.length),
            )
            fallback = {
              lines: redact(buffer.subarray(0, bytesRead).toString('utf8'), secrets).split(/\r?\n/),
            }
          } finally {
            await file.close()
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    }
    return c.json({ workling, pi, fallback, ended: !!row.endedAt })
  })
  app.get('/api/runs/:id/log', async (c) => {
    const id = repoId(c.req.param('id'))
    const row = id ? db.select().from(runs).where(eq(runs.id, id)).get() : undefined
    if (!row) return c.json({ error: '执行记录不存在' }, 404)
    const rawOffset = c.req.query('offset')
    if (
      rawOffset !== undefined &&
      (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)))
    )
      return c.json({ error: 'offset 无效' }, 400)
    try {
      if (!row.taskDir) throw new Error('日志已清理')
      const path = join(assertTaskDir(options.workspace, row.taskDir), 'task.log')
      const file = await open(path, 'r')
      try {
        const size = (await file.stat()).size
        if (rawOffset !== undefined) {
          const offset = Number(rawOffset)
          const buffer = Buffer.alloc(Math.min(Math.max(size - offset, 0), 1024 * 1024))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          let content = buffer.subarray(0, bytesRead)
          // 跨片段的密钥无法在单次响应中识别；保留原始字节以支持跨片段 UTF-8 解码。
          for (const secret of (options.secrets?.() ?? [])
            .filter(Boolean)
            .sort((a, b) => b.length - a.length)) {
            const needle = Buffer.from(secret)
            const parts: Buffer[] = []
            let start = 0
            let index = content.indexOf(needle, start)
            while (index !== -1) {
              parts.push(content.subarray(start, index), Buffer.from('***'))
              start = index + needle.length
              index = content.indexOf(needle, start)
            }
            parts.push(content.subarray(start))
            content = Buffer.concat(parts)
          }
          return c.body(content, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Log-Offset': String(offset + bytesRead),
            'X-Run-Ended': String(!!row.endedAt),
          })
        }
        const limit = 5 * 1024 * 1024
        const buffer = Buffer.alloc(Math.min(size, limit))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - limit))
        const content = redact(
          buffer.subarray(0, bytesRead).toString('utf8'),
          options.secrets?.() ?? [],
        )
        return c.body(`${size > limit ? '（日志较长，仅显示最后 5 MB）\n' : ''}${content}`, 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Log-Offset': String(size),
          'X-Run-Ended': String(!!row.endedAt),
        })
      } finally {
        await file.close()
      }
    } catch {
      return c.json({ error: '日志已清理' }, 404)
    }
  })
  return app
}
