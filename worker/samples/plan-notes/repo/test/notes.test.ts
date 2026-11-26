import { beforeEach, expect, test } from 'bun:test'
import { addNote, listNotes, removeNote } from '../src/notes.ts'
import { exportNotes, importNotes } from '../src/storage.ts'

beforeEach(() => importNotes('[]'))

test('lists notes in insertion order and removes a note by ID', () => {
  const first = addNote('first')
  const second = addNote('second')
  expect(listNotes()).toEqual([first, second])
  expect(removeNote(first.id)).toBe(true)
  expect(removeNote(first.id)).toBe(false)
  expect(listNotes()).toEqual([second])
})

test('exports and restores notes without reusing imported IDs', () => {
  const note = addNote('keep me')
  const json = exportNotes()
  expect(JSON.parse(json)).toEqual([{ id: 1, text: 'keep me' }])
  removeNote(note.id)
  importNotes(json)
  expect(listNotes()).toEqual([note])
  expect(addNote('next').id).toBeGreaterThan(note.id)
})

test('keeps existing notes when an import contains an invalid entry', () => {
  const note = addNote('keep me')
  expect(() => importNotes('[{"id":2,"text":"valid"},{"id":3}]')).toThrow('Invalid note')
  expect(listNotes()).toEqual([note])
})
