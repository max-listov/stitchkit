import { defineContract } from 'stitchkit';
import { z } from 'zod';

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const CreateNoteSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
});

export const UpdateNoteSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
});

export const IdSchema = z.object({ id: z.string() });

export const ListInputSchema = z.object({
  search: z.string().optional(),
});

export type Note = z.infer<typeof NoteSchema>;

export const notes = defineContract(
  { prefix: 'notes' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List all notes, optionally filter by search query',
      input: ListInputSchema,
      output: z.array(NoteSchema),
    },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a new note with title and content',
      input: CreateNoteSchema,
      output: NoteSchema,
    },
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get a single note by ID',
      params: IdSchema,
      output: NoteSchema,
    },
    update: {
      method: 'PATCH',
      path: '/:id',
      desc: 'Update note title or content',
      params: IdSchema,
      input: UpdateNoteSchema,
      output: NoteSchema,
    },
    delete: {
      method: 'DELETE',
      path: '/:id',
      desc: 'Delete a note by ID',
      params: IdSchema,
    },
  },
);

/** Server → client Socket.IO events. */
export interface ServerToClientEvents {
  'data:updated': (data: { file: string }) => void;
}

/** Client → server Socket.IO events — none in this app. */
export interface ClientToServerEvents {
  [event: string]: never;
}
