import {
  createNDJSONDecoder,
  type NDJSONDecoder,
  parseNDJSON,
  type StreamByteSource,
  StreamLineLimitError,
  StreamTruncatedLineError,
} from 'stitchkit';
import type {
  BoundedAdmissionClock,
  ManagedScheduleClock,
  RevisionSignalClock,
} from 'stitchkit/application';
import {
  classifyTelegramSendFailure,
  createTelegramBotTransport,
  type TelegramFetch,
  TelegramNotDispatchedError,
  type TelegramNotDispatchedStage,
  type TelegramSendFailureReason,
  telegramOperatorSender,
} from 'stitchkit/telegram';
import {
  createManualClock,
  type ManualClock,
  ManualClockError,
  type ManualClockErrorCode,
  type ManualClockHold,
} from 'stitchkit/testing';

// Every byte source the NDJSON reader accepts, named by the public union.
declare const stdout: ReadableStream<Uint8Array>;
declare const chunks: AsyncIterable<Uint8Array>;
const sources: StreamByteSource[] = [new Response(''), stdout, chunks];
void sources;
const reading: AsyncGenerator<{ n: number }> = parseNDJSON<{ n: number }>(stdout, {
  maxLineBytes: 1024,
  finalLine: 'require-newline',
  signal: new AbortController().signal,
});
void reading;
const decoder: NDJSONDecoder<{ n: number }> = createNDJSONDecoder<{ n: number }>();
const values: { n: number }[] = decoder.push(new Uint8Array());
void values;
// @ts-expect-error — a push decoder does not own its source, so it takes no signal.
createNDJSONDecoder({ signal: new AbortController().signal });
const limit: RangeError = new StreamLineLimitError(10, 11);
const sizes: [number, number] = [
  new StreamLineLimitError(10, 11).limitBytes,
  limit.message.length,
];
const truncated: SyntaxError = new StreamTruncatedLineError(3);
void sizes;
void truncated;

// One manual clock serves every timer boundary a schedule takes.
const clock: ManualClock = createManualClock({ holdLimitMs: 1_000 });
const scheduleClock: ManagedScheduleClock = clock;
const admissionClock: BoundedAdmissionClock = clock;
const revisionClock: RevisionSignalClock = clock;
void admissionClock;
void revisionClock;
const held: ManualClockHold = clock.hold('fake upstream');
const unpark: () => void = held.park();
unpark();
held.release();
const advanced: Promise<void> = clock.advance(1_000);
const waited: Promise<number> = clock.until(() => true, { limitMs: 5_000 });
const code: ManualClockErrorCode = new ManualClockError('MANUAL_CLOCK_LIMIT', 'x').code;
void scheduleClock;
void advanced;
void waited;
void code;

// The transport is the senders' `fetch`, and its refusal is a classified, retryable outcome.
const transport: TelegramFetch = createTelegramBotTransport({ connectAttemptMs: 1_000 });
const globalFetch: TelegramFetch = fetch;
void telegramOperatorSender({ token: '1:s', fetch: transport });
void globalFetch;
const stage: TelegramNotDispatchedStage = new TelegramNotDispatchedError('connect', 'x').stage;
const reason: TelegramSendFailureReason = classifyTelegramSendFailure(
  new TelegramNotDispatchedError('lookup', 'x'),
).reason;
const exhaustive: Record<TelegramSendFailureReason, true> = {
  'blocked-by-user': true,
  'user-deactivated': true,
  'chat-not-found': true,
  'not-started': true,
  'rate-limited': true,
  'message-invalid': true,
  'server-error': true,
  'not-dispatched': true,
  unknown: true,
};
void stage;
void reason;
void exhaustive;
