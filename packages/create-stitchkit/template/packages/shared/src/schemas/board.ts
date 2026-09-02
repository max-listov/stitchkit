import { z } from 'zod';

/**
 * One note on the board.
 *
 * Small on purpose: the board exists to show a value that several browsers
 * watch at once, and everything about it that is not that gets in the way.
 */
export const NoteSchema = z
  .object({
    id: z.uuid(),
    /** Trimmed and bounded here, so the same limit holds for every transport. */
    body: z.string().trim().min(1).max(140),
    postedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Note = z.infer<typeof NoteSchema>;

/** What a reader of the board receives — newest first, and how many there are. */
export const BoardSchema = z
  .object({
    notes: z.array(NoteSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type Board = z.infer<typeof BoardSchema>;

/** What a writer sends. The server owns `id` and `postedAt`; a client cannot set either. */
export const PostNoteSchema = z.object({ body: NoteSchema.shape.body }).strict();
export type PostNote = z.infer<typeof PostNoteSchema>;

/**
 * The payload of the announcement that the board changed.
 *
 * It carries the note's id rather than the note. An announcement says *that*
 * something changed; the value comes from the read, which is the one place that
 * decides what a reader is allowed to see. A payload that carried the row would
 * be a second, unauthorised copy of the answer.
 */
export const BoardChangedSchema = z.object({ noteId: NoteSchema.shape.id }).strict();
export type BoardChanged = z.infer<typeof BoardChangedSchema>;
