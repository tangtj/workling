import { listNotes, replaceNotes, type Note } from './notes.ts'

export function exportNotes(): string {
  return JSON.stringify(listNotes())
}

export function importNotes(json: string): void {
  const data: unknown = JSON.parse(json)
  if (!Array.isArray(data)) throw new Error('Expected an array of notes')
  const notes: Note[] = []
  const ids = new Set<number>()
  for (const entry of data as unknown[]) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('id' in entry) ||
      typeof entry.id !== 'number' ||
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1 ||
      ids.has(entry.id) ||
      !('text' in entry) ||
      typeof entry.text !== 'string'
    )
      throw new Error('Invalid note')
    ids.add(entry.id)
    notes.push({ id: entry.id, text: entry.text })
  }
  replaceNotes(notes)
}
