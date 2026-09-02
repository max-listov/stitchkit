'use client';

import type { Board } from '@app/shared';
import { useEffect, useState } from 'react';
import type { WatchStateFrame } from 'stitchkit/live';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from '@/components/ui';
import { boardApi, watchBoard } from './board-live';

/**
 * The board, live.
 *
 * The demonstration is the second tab: open one, post from the other, and the
 * note appears without this component asking for it. Nothing here polls, and
 * nothing here refetches after a write — the server re-reads once, for everyone
 * watching, and pushes the answer.
 */
export function BoardPanel({ realtimeOrigin }: { realtimeOrigin?: string }) {
  const [board, setBoard] = useState<Board>();
  const [state, setState] = useState<WatchStateFrame>();
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    const watch = watchBoard(setBoard, setState, realtimeOrigin);
    return () => watch.close();
  }, [realtimeOrigin]);

  async function post(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      // The write returns the board too, so this tab does not wait for its own
      // announcement to come back around. Every other tab learns from the push.
      setBoard(await boardApi.post({ body }));
      setDraft('');
    } finally {
      setPosting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Board</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <form className='flex gap-2' onSubmit={post}>
          <Input
            aria-label='Note'
            maxLength={140}
            onChange={(event) => setDraft(event.target.value)}
            placeholder='Say something, then open a second tab'
            value={draft}
          />
          <Button disabled={posting || draft.trim().length === 0} type='submit'>
            Post
          </Button>
        </form>

        <BoardStatus board={board} state={state} />

        <ul className='space-y-2'>
          {board?.notes.map((note) => (
            <li className='rounded-md border px-3 py-2 text-sm' key={note.id}>
              {note.body}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Three states, not two.
 *
 * `opening` is subscribed and nothing read yet — early, not broken — and showing
 * it as a failure tells a reader something is wrong when the truth is that it
 * has not arrived. `unavailable` shows the read's own words, because "something
 * went wrong" is the message that helps nobody.
 */
function BoardStatus({ board, state }: { board?: Board; state?: WatchStateFrame }) {
  if (state?.phase === 'unavailable') {
    return (
      <p className='text-destructive text-sm'>
        Not live: {state.message ?? state.reason ?? 'the server stopped answering'}
      </p>
    );
  }
  if (!board) {
    return (
      <p className='flex items-center gap-2 text-muted-foreground text-sm'>
        <Spinner /> Waiting for the first read…
      </p>
    );
  }
  return (
    <p className='text-muted-foreground text-sm'>
      {board.total} {board.total === 1 ? 'note' : 'notes'}, live
    </p>
  );
}
