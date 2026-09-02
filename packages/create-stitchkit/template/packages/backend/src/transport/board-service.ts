import { type Board, boardContract } from '@app/shared';
import { implement } from 'stitchkit/server';
import type { BoardRuntime } from '../lib/board';

/**
 * The board's two operations.
 *
 * Nothing here knows it is watched. `list` is an ordinary handler that reads
 * memory and returns; the watch hub calls this same implementation when a topic
 * says the answer may have changed, so a watching browser and a plain `GET` can
 * never disagree — there is one reader, not two.
 */
export function createBoardService(board: BoardRuntime) {
  return implement(boardContract, {
    list: (): Board => board.read(),
    post: ({ input }) => board.post(input),
  });
}
