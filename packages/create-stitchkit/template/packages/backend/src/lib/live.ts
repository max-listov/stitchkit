import { boardContract, liveContract } from '@app/shared';
import { createWatchHub, type WatchHub } from 'stitchkit/application';
import { bindRealtimeServer, type RealtimeServerHandle } from 'stitchkit/server';
import type { BoardRuntime } from './board';

/** What makes the board’s answer stale — the one topic, named once. */
const INVALIDATED_BY = 'board.changed';

/** A read the browser is allowed to watch. */
const WATCHABLE = new Set([`${boardContract.meta.prefix}/list`]);

export interface LiveHandle {
  readonly hub: WatchHub;
}

export function bindLive(board: BoardRuntime, handle: RealtimeServerHandle): LiveHandle {
  const realtime = bindRealtimeServer(liveContract, handle, {
    onRejected: (rejected) => {
      // A frame that failed its schema is reported where it was refused. Silence
      // here is how two versions of an application go on talking past each other.
      console.warn(`Realtime frame refused: ${rejected.event} (${rejected.reason})`);
    },
  });

  const hub = createWatchHub({
    // The hub does not dispatch; it asks the application. One reader for the
    // watched answer and the plain `GET` alike, so the two cannot disagree.
    read: async (operation) => {
      if (operation.action !== 'list') {
        throw new Error(`${operation.service}.${operation.action} is not readable here`);
      }
      return board.read();
    },
    watchable: (operation) => WATCHABLE.has(`${operation.service}/${operation.action}`),
    // The board's list takes no arguments, so its topic is the whole board.
    // When a read *does* depend on an argument — one conversation of many — the
    // topic is narrowed with it (`board.changed:${args.id}`), or one change wakes
    // every watcher of the operation and pays for a read per watcher.
    invalidatedBy: () => [INVALIDATED_BY],
    subscribe: (topic, listener) => {
      // The hub hands back the topics `invalidatedBy` returned, so this is a
      // narrowing rather than a check — and it refuses rather than quietly
      // returning a no-op, because an invalidation that silently never fires
      // is a board that stops updating with nothing to show for it.
      if (topic !== INVALIDATED_BY) {
        throw new Error(`The board declares no invalidation topic named ${topic}`);
      }
      return board.events.on(topic, listener);
    },
    // A browser may watch a handful of questions, not an unbounded number: the
    // limit is what turns a bug in a page into a refusal instead of a leak.
    maxWatchesPerSubscriber: 8,
    // A page that navigates away and back inside the window finds the answer
    // warm and costs no read.
    holdMs: 30_000,
  });

  realtime.onConnection(({ raw, events }) => {
    const watcher = hub.attach({
      value: (frame) => events.emit('stitchkit.watch.value', frame),
      state: (frame) => events.emit('stitchkit.watch.state', frame),
    });
    events.on('stitchkit.watch.open', (payload, acknowledge) => {
      acknowledge(watcher.open(payload.key, payload.args));
    });
    events.on('stitchkit.watch.close', (payload) => watcher.close(payload.key));
    // Every key this connection held is released here. Without it the hub goes
    // on re-reading for a browser that closed its tab.
    raw.on('disconnect', () => watcher.detach());
  });

  return { hub };
}
