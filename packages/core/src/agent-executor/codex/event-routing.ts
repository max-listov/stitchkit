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

  defer(params: JsonRpcValue | undefined, deliver: () => void): void {
    if (this.failure !== undefined) throw this.failure;
    this.bytes += JSON.stringify(params ?? null).length;
    if (this.waiting.length >= TURN_QUEUE.maxItems || this.bytes > TURN_QUEUE.maxBytes) {
      this.failure = new Error('Codex events before turn/start exceeded the turn queue limit');
      throw this.failure;
    }
    this.waiting.push(deliver);
  }

  flush(): void {
    for (const deliver of this.waiting.splice(0)) deliver();
    if (this.failure !== undefined) throw this.failure;
  }
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
