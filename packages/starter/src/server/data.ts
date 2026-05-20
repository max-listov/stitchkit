import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Note } from '@shared/contracts';

const __dirname = import.meta.dir ?? dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '../../data');
const NOTES_FILE = join(DATA_DIR, 'notes.json');

function readNotes(): Note[] {
  try {
    return JSON.parse(readFileSync(NOTES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeNotes(notes: Note[]): void {
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

export function listNotes(search?: string): Note[] {
  let all = readNotes().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (search) {
    const q = search.toLowerCase();
    all = all.filter(
      (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q),
    );
  }
  return all;
}

export function getNote(id: string): Note | undefined {
  return readNotes().find((n) => n.id === id);
}

export function createNote(input: { title: string; content: string }): Note {
  const notes = readNotes();
  const note: Note = {
    id: String(Date.now()),
    title: input.title,
    content: input.content,
    createdAt: new Date().toISOString(),
  };
  notes.push(note);
  writeNotes(notes);
  return note;
}

export function updateNote(
  id: string,
  input: { title?: string; content?: string },
): Note | undefined {
  const notes = readNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) return undefined;
  if (input.title !== undefined) note.title = input.title;
  if (input.content !== undefined) note.content = input.content;
  writeNotes(notes);
  return note;
}

export function deleteNote(id: string): void {
  const notes = readNotes().filter((n) => n.id !== id);
  writeNotes(notes);
}
