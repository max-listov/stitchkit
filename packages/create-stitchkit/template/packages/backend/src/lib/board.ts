import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '@app/config';
import { type Board, boardEvents, type Note, NoteSchema, type PostNote } from '@app/shared';
import {
  defineKeyspace,
  type OpenedKeyspace,
  openKeyspace,
  sqliteKeyspaceBackend,
} from 'stitchkit/application';
import type { EventPayloads } from 'stitchkit/live';
import { createEventBus, type EventBus } from 'stitchkit/server';

/**
 * The board's notes: authoritative in memory, durable behind it.
 *
 * A keyspace and not a Prisma model, deliberately, and the boundary is worth
 * knowing rather than guessing. A keyspace is for a **small, bounded set the
 * whole process wants synchronously** — read it in a handler without awaiting,
 * write it and know the write survived. The moment a thing wants queries,
 * relations, pagination or unbounded growth, it is a database row and this is
 * the wrong home for it.
 */
const notes = defineKeyspace('notes', {
  schema: NoteSchema,
  key: (note: Note) => note.id,
});

/** The board, and the lifecycle its owner drives. */
export interface BoardRuntime {
  /** Every announcement this role makes. Subscribed by the watch hub. */
  readonly events: EventBus<EventPayloads<typeof boardEvents>>;
  /** Synchronous, from memory. This is what makes a watched read cheap. */
  read(): Board;
  post(input: PostNote): Promise<Board>;
  close(): Promise<void>;
}

const MOST_RECENT = 50;

export async function openBoard(): Promise<BoardRuntime> {
  // Closed by the declaration: an undeclared topic is refused rather than
  // delivered to nobody, and a topic can only be announced by the verb its
  // declaration chose.
  const events = createEventBus<EventPayloads<typeof boardEvents>>({
    topics: boardEvents.topics,
    onListenerError: (error, event) => {
      console.error(`Listener for ${event} failed`, error);
    },
  });

  // The directory too, not only the file. A starter that requires an operator to
  // create a folder before it will boot is a starter that fails on the first run
  // with an error about SQLite rather than about what is missing.
  mkdirSync(dirname(env.BOARD_STORE_PATH), { recursive: true });
  const database = new Database(env.BOARD_STORE_PATH, { create: true });

  // Opened directly rather than declared to a kernel, because this role owns
  // its own lifecycle: it binds its signals and closes what it holds in the
  // order `cleanup.ts` lists. An application built on `createApplication` would
  // declare `keyspaceResource(notes, …)` instead and let the graph order it.
  const opened: OpenedKeyspace<Note> = await openKeyspace(notes, {
    backend: sqliteKeyspaceBackend(notes, { database }),
    // After durability and after memory — never before either. A subscriber
    // woken by this reads immediately, and an announcement that arrived first
    // would be a wake-up to the previous value.
    onChanged: (change) => events.emit('board.changed', { noteId: change.key }),
  });

  function read(): Board {
    const all = [...opened.keyspace.list()].sort((left, right) =>
      right.postedAt.localeCompare(left.postedAt),
    );
    return { notes: all.slice(0, MOST_RECENT), total: all.length };
  }

  return {
    events,
    read,
    async post(input) {
      await opened.keyspace.put({
        id: crypto.randomUUID(),
        body: input.body,
        postedAt: new Date().toISOString(),
      });
      // The write resolved, so it is durable and in memory; this read cannot
      // miss it. The watchers hear about it through the announcement above.
      return read();
    },
    async close() {
      opened.stopAdmission();
      await opened.drain();
      await opened.close();
      database.close();
      events.clear();
    },
  };
}
