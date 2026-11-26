import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

export function missingOutput(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// out/ 对 worker 可写。只读取普通文件，拒绝符号链接和超出大小限制的内容。
export async function readOutputFile(
  dir: string,
  name: string,
  maxBytes: number,
  truncate = false,
): Promise<Buffer> {
  const handle = await open(
    join(dir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`out/${name} 不是普通文件`)
    if (!truncate && stat.size > maxBytes) throw new Error(`out/${name} 超出大小限制`)
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, maxBytes) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) return buffer.subarray(0, offset)
      offset += bytesRead
    }
    if (truncate && stat.size >= maxBytes) return buffer
    throw new Error(`读取时 out/${name} 大小发生变化`)
  } finally {
    await handle.close()
  }
}
