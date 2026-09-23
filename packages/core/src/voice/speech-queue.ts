/*
 * The sentences of a live reply, spoken in order, with the next one synthesised while the
 * current one plays.
 *
 * A queue that synthesises only after the previous sentence finished playing leaves a gap as
 * long as the synthesis between every two sentences — most of a second for a synthesiser that
 * returns the whole clip. Here up to `lookahead` sentences are prepared while one plays, so the
 * next clip is usually ready when the current one ends. Closing the queue lets it finish what
 * it has; cancelling it — the listener interrupted — aborts the playing sentence and every
 * synthesis in flight, and nothing after that is said.
 */

export interface SpeechQueueOptions<Prepared> {
  /** Synthesise one sentence. Aborted when the queue is cancelled. */
  prepare: (text: string, signal: AbortSignal) => Promise<Prepared>;
  /** Play one prepared sentence to its end. Aborted when the queue is cancelled. */
  play: (prepared: Prepared, signal: AbortSignal) => Promise<void>;
  /** Sentences prepared ahead of the one playing. Default 1; 0 prepares only after playing. */
  lookahead?: number;
  /** A sentence that failed to prepare or play is skipped; the queue goes on. */
  onError?: (error: unknown, text: string) => void;
  /** A prepared sentence that will never play — cancelled — to release what it holds. */
  discard?: (prepared: Prepared) => void;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Slot<Prepared> {
  text: string;
  controller: AbortController;
  result: Promise<Outcome<Prepared>>;
}

const CANCELLED = Symbol('cancelled');

function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
}

export class SpeechQueue<Prepared> {
  readonly done: Promise<void>;
  private readonly lookahead: number;
  private readonly pending: string[] = [];
  private readonly ahead: Slot<Prepared>[] = [];
  private current: Slot<Prepared> | null = null;
  private playing = false;
  private closed = false;
  private cancelled = false;
  private wake: (() => void) | null = null;
  private stop!: (value: typeof CANCELLED) => void;
  private readonly stopped = new Promise<typeof CANCELLED>((resolve) => {
    this.stop = resolve;
  });

  constructor(private readonly options: SpeechQueueOptions<Prepared>) {
    const lookahead = options.lookahead ?? 1;
    if (!Number.isInteger(lookahead) || lookahead < 0) {
      throw new RangeError(`lookahead must be a non-negative integer, got ${lookahead}`);
    }
    this.lookahead = lookahead;
    this.done = this.run();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get isSpeaking(): boolean {
    return this.playing;
  }

  /** Add one sentence. Blank text and anything after `close` or `cancel` is ignored. */
  push(text: string): void {
    if (this.closed || this.cancelled || text.trim() === '') return;
    this.pending.push(text);
    this.fill();
    this.notify();
  }

  /** The turn is over: say what is queued, then finish. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  /** Interrupted: abort the sentence playing and every synthesis, drop the rest. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.closed = true;
    this.pending.length = 0;
    const unplayed = this.ahead.splice(0);
    if (this.current && !this.playing) unplayed.push(this.current);
    this.current?.controller.abort();
    for (const slot of unplayed) {
      slot.controller.abort();
      void slot.result.then((outcome) => {
        if (outcome.ok) this.release(outcome.value);
      });
    }
    this.stop(CANCELLED);
    this.notify();
  }

  private notify(): void {
    this.wake?.();
  }

  /** Start synthesis up to the lookahead: the sentence playing or next, plus `lookahead`. */
  private fill(): void {
    const capacity = this.lookahead + 1 - (this.current ? 1 : 0);
    while (!this.cancelled && this.ahead.length < capacity && this.pending.length > 0) {
      const text = this.pending.shift() as string;
      const controller = new AbortController();
      this.ahead.push({
        text,
        controller,
        result: settle(() => this.options.prepare(text, controller.signal)),
      });
    }
  }

  private async run(): Promise<void> {
    while (!this.cancelled) {
      this.fill();
      const slot = this.ahead.shift();
      if (!slot) {
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      this.current = slot;
      try {
        const prepared = await Promise.race([slot.result, this.stopped]);
        if (prepared === CANCELLED) return;
        if (!prepared.ok) {
          this.report(prepared.error, slot.text);
          continue;
        }
        this.playing = true;
        this.fill();
        const played = await Promise.race([
          settle(() => this.options.play(prepared.value, slot.controller.signal)),
          this.stopped,
        ]);
        if (played === CANCELLED) return;
        if (!played.ok) this.report(played.error, slot.text);
      } finally {
        this.playing = false;
        this.current = null;
      }
    }
  }

  private report(error: unknown, text: string): void {
    try {
      this.options.onError?.(error, text);
    } catch {
      // The queue outlives its observer.
    }
  }

  private release(prepared: Prepared): void {
    try {
      this.options.discard?.(prepared);
    } catch {
      // Releasing is best effort.
    }
  }
}
