export interface Note {
  id: number
  text: string
}

let notes: Note[] = []
let nextId = 1

export function addNote(text: string): Note {
  const note = { id: nextId++, text }
  notes.push(note)
  return { ...note }
}

export function listNotes(): Note[] {
  return notes.map((note) => ({ ...note }))
}

export function removeNote(id: number): boolean {
  const index = notes.findIndex((note) => note.id === id)
  if (index < 0) return false
  notes.splice(index, 1)
  return true
}

export function replaceNotes(imported: Note[]): void {
  notes = imported.map((note) => ({ ...note }))
  nextId = notes.reduce((next, note) => Math.max(next, note.id + 1), 1)
}
