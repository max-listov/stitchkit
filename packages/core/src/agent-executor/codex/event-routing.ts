import { utf8ByteLength } from '../../internal/bounded-body';
import { isRecord } from '../../internal/typed';
import type { JsonRpcValue } from '../json-rpc-peer';
import { nonEmptyString, TURN_QUEUE } from '../session-primitives';
import type { CodexTurnSlot } from './request-answers';

function field(object: unknown, key: string): string | undefined {
  return isRecord(object) ? nonEmptyString(object[key]) : undefined;
}

export function codexThreadIdOf(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return (
    field(params, 'threadId') ??
    field(params.thread, 'id') ??
    field(params.turn, 'threadId') ??
    field(params.item, 'threadId')
  );
}

export function codexTurnIdOf(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return field(params, 'turnId') ?? field(params.turn, 'id') ?? field(params.item, 'turnId');
}

interface StartingEvent {
  readonly deliver: () => void;
  /** Answers a held server request when the buffer is refused instead of delivered. */
  readonly refuse: (() => void) | undefined;
}

/** Hold candidate events only until the authoritative turn/start reply identifies their owner. */
export class CodexStartingTurn {
  private readonly waiting: StartingEvent[] = [];
  private bytes = 0;
  private failure?: Error;
  private discarded = false;
  private flushing = false;
  private observed: string | undefined;

  constructor(private readonly limits: { maxItems: number; maxBytes: number } = TURN_QUEUE) {}

  get isBuffering(): boolean {
    return !this.discarded && !this.flushing;
  }

  /** The native turn id a buffered event named before the turn/start reply did. */
  get observedTurnId(): string | undefined {
    return this.observed;
  }

  /**
   * Hold one event until the reply. Past the queue limit the event is not held and the overflow is
   * returned — never thrown into the connection's reader — so the turn fails at its flush the same
   * way on a single session and on a shared server; a held request answers with that error.
   */
  defer(
    params: JsonRpcValue | undefined,
    deliver: () => void,
    refuse?: () => void,
  ): Error | undefined {
    if (!this.isBuffering) return undefined;
    if (this.failure !== undefined) return this.failure;
    this.bytes += utf8ByteLength(JSON.stringify(params ?? null));
    if (this.waiting.length >= this.limits.maxItems || this.bytes > this.limits.maxBytes) {
      this.failure = new Error('Codex events before turn/start exceeded the turn queue limit');
      return this.failure;
    }
    this.observed ??= codexTurnIdOf(params);
    this.waiting.push({ deliver, refuse });
    return undefined;
  }

  /** Drop buffered pre-start events without delivery when a session closes or disconnects. */
  discard(): void {
    this.drop();
  }

  /** Drop buffered events and answer every held server request with its stopped answer. */
  refuse(): void {
    for (const event of this.drop()) event.refuse?.();
  }

  flush(shouldContinue?: () => boolean): void {
    this.flushing = true;
    try {
      const waiting = this.waiting.splice(0);
      for (const event of waiting) {
        if (this.discarded || shouldContinue?.() === false) {
          this.discard();
          return;
        }
        event.deliver();
      }
      if (!this.discarded && shouldContinue?.() !== false && this.failure !== undefined) {
        throw this.failure;
      }
    } finally {
      this.flushing = false;
    }
  }

  private drop(): StartingEvent[] {
    this.discarded = true;
    const dropped = this.waiting.splice(0);
    this.bytes = 0;
    this.failure = undefined;
    return dropped;
  }
}

/** Detach and discard any pre-start buffer on `turn` without invoking observers. */
export function discardStartingTurn(turn: CodexTurnSlot | undefined): void {
  if (turn?.starting === undefined) return;
  const starting = turn.starting;
  delete turn.starting;
  starting.discard();
}

/**
 * Detach the pre-start buffer and answer its held server requests as stopped. Only for a thread
 * no one else can answer on — a closed thread of a shared stdio server; a connection a human
 * shares through a TUI keeps {@link discardStartingTurn}.
 */
export function refuseStartingTurn(turn: CodexTurnSlot | undefined): void {
  if (turn?.starting === undefined) return;
  const starting = turn.starting;
  delete turn.starting;
  starting.refuse();
}

export function codexEventTurn(
  current: CodexTurnSlot | undefined,
  params: unknown,
): CodexTurnSlot | undefined {
  if (current === undefined) return undefined;
  const threadId = codexThreadIdOf(params);
  if (
    threadId !== undefined &&
    current.threadId !== undefined &&
    threadId !== current.threadId
  )
    return undefined;
  const turnId = codexTurnIdOf(params);
  if (
    turnId !== undefined &&
    current.codexTurnId !== undefined &&
    turnId !== current.codexTurnId
  )
    return undefined;
  return current;
}
