import { createContractFactory } from 'stitchkit';
import { defineEvents } from 'stitchkit/live';
import { BoardChangedSchema, BoardSchema, PostNoteSchema } from '../schemas/board';

const { defineContract } = createContractFactory<'public'>({
  toolExposure: 'explicit',
});

/**
 * The board: read it, add to it.
 *
 * Two operations, and the interesting one is `list` — it is a **watched read**.
 * Nothing about that shows up here, which is the point: a watched read is an
 * ordinary `GET` that the server happens to re-run when something it depends on
 * changes. The contract stays the contract, and one caller can fetch it once
 * while another watches it.
 */
export const boardContract = defineContract(
  { prefix: 'board', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'Read the board',
      output: BoardSchema,
      expose: ['HTTP'],
    },
    post: {
      method: 'POST',
      path: '/',
      desc: 'Add a note to the board',
      input: PostNoteSchema,
      output: BoardSchema,
      expose: ['HTTP'],
    },
  },
);

/**
 * What the server announces, declared beside what it can be asked.
 *
 * One topic, one payload schema, and a delivery mode — `emit`, because an
 * announcement that the board changed is an observation and nothing waits on it.
 * The wire name is the prefixed one, `board.changed`, and it is the only name
 * this topic has: the short key below is where the full one is built.
 *
 * Declared in `shared` for the same reason the contract is: the server publishes
 * it and the browser subscribes to it, and a topic described twice is a topic
 * that will be published in one shape and parsed in another.
 */
export const boardEvents = defineEvents(
  { prefix: 'board' },
  { changed: { schema: BoardChangedSchema, mode: 'emit' } },
);
