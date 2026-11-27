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

/** Hold candidate events only until the authoritative turn/start reply identifies their owner. */
export class CodexStartingTurn {
  private readonly waiting: Array<() => void> = [];
  private bytes = 0;
  private failure?: Error;
  private discarded = false;
  private flushing = false;

  get isBuffering(): boolean {
    return !this.discarded && !this.flushing;
  }

  defer(params: JsonRpcValue | undefined, deliver: () => void): void {
    if (!this.isBuffering) return;
    if (this.failure !== undefined) throw this.failure;
    this.bytes += JSON.stringify(params ?? null).length;
    if (this.waiting.length >= TURN_QUEUE.maxItems || this.bytes > TURN_QUEUE.maxBytes) {
      this.failure = new Error('Codex events before turn/start exceeded the turn queue limit');
      throw this.failure;
    }
    this.waiting.push(deliver);
  }

  /** Drop buffered pre-start events without delivery when a session closes or disconnects. */
  discard(): void {
    this.discarded = true;
    this.waiting.length = 0;
    this.bytes = 0;
    this.failure = undefined;
  }

  flush(shouldContinue?: () => boolean): void {
    this.flushing = true;
    try {
      for (const deliver of this.waiting.splice(0)) {
        if (this.discarded || shouldContinue?.() === false) {
          this.discard();
          return;
        }
        deliver();
      }
      if (!this.discarded && shouldContinue?.() !== false && this.failure !== undefined) {
        throw this.failure;
      }
    } finally {
      this.flushing = false;
    }
  }
}

/** Detach and discard any pre-start buffer on `turn` without invoking observers. */
export function discardStartingTurn(turn: CodexTurnSlot | undefined): void {
  if (turn?.starting === undefined) return;
  const starting = turn.starting;
  delete turn.starting;
  starting.discard();
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
