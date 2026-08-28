/**
 * The long-lived streaming surface, through the published package.
 *
 * The in-repo suite imports from `src`, in one process, with everything in
 * scope. A consumer gets a tarball, an `exports` map and the emitted
 * declarations — and the gap between those two views is where this repository's
 * defects have historically lived: a type named in a public signature and
 * exported from no entrypoint, a value delivered to a hook nobody can reach, a
 * bundler-folded read. A new public API that never crosses that gap before it
 * ships is the same bet those defects came from.
 *
 * So every annotation here is deliberate — a type that is internal compiles in
 * `src` and fails on this line — and the route is actually served and actually
 * read, from `dist`, at run time.
 *
 * Scope, stated rather than implied: the realtime refusal surface is covered
 * here at the level this fixture can reach — the names resolve and the pure
 * recogniser behaves — because a two-peer refusal needs the Socket.IO peers,
 * which this fixture deliberately does not install. Its end-to-end behaviour is
 * pinned in `packages/core/tests/realtime-rejection-visibility.test.ts`.
 */

import {
  asRealtimeRejection,
  createClient,
  defineContract,
  type ParseNDJSONOptions,
  parseNDJSON,
  parseSSE,
  REALTIME_REJECTION_KEY,
  type RealtimeRejectionIssue,
  type RealtimeRejectionReport,
  RealtimeRequestRejectedError,
} from 'stitchkit';
import {
  createServer,
  DEFAULT_STREAM_HEARTBEAT_MS,
  implement,
  ndjsonRoute,
  type RawRoute,
  type StreamingFormat,
  type StreamingRouteOptions,
  type StreamingSourceContext,
  sseRoute,
  streamingRoute,
} from 'stitchkit/server';
import { z } from 'zod';

function fail(what: string): never {
  throw new Error(`[minimal] streaming subscription: ${what}`);
}

/**
 * `setTimeout`, not `Bun.sleep`. This fixture is the smallest real consumer and
 * installs no `@types/bun` — reaching for a runtime global here would be the
 * fixture quietly granting itself something the consumer it stands for does not
 * have, which is exactly the kind of gap it exists to close.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A source that never yields and reports when it was closed. */
function silentSource(): {
  source: (request: Request, context: StreamingSourceContext) => AsyncIterable<unknown>;
  closed: Promise<void>;
} {
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  async function* generate(
    _request: Request,
    { signal }: StreamingSourceContext,
  ): AsyncGenerator<unknown> {
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      markClosed();
    }
  }
  return { source: generate, closed };
}

async function* threeFrames(): AsyncGenerator<unknown> {
  yield { n: 1 };
  await sleep(60);
  yield { n: 2 };
  await sleep(60);
  yield { n: 3 };
}

// `RawRoute` from `stitchkit/server` is already bound to the Bun server type —
// it is an alias, not a generic. Naming it here is the point: a route helper
// whose result cannot be annotated with the type the entrypoint actually
// publishes is unusable, and only a consumer's tsconfig can find that out.
const quiet = silentSource();
const events: RawRoute = ndjsonRoute({
  path: '/events',
  heartbeatMs: 60,
  source: quiet.source,
});

const frames: RawRoute = ndjsonRoute({
  path: '/frames',
  heartbeatMs: 25,
  source: threeFrames,
});

const sse: RawRoute = sseRoute({ path: '/sse', source: threeFrames });

// The general form, with every option named, so a renamed or removed field is a
// compile error in a consumer's tree rather than a surprise at run time.
const format: StreamingFormat = 'ndjson';
const generalOptions: StreamingRouteOptions<unknown> = {
  path: '/general',
  method: 'GET',
  format,
  heartbeatMs: DEFAULT_STREAM_HEARTBEAT_MS,
  idleTimeoutSeconds: 0,
  headers: { 'x-consumer': 'minimal' },
  source: threeFrames,
};
const general: RawRoute = streamingRoute(generalOptions);

const typedContract = defineContract(
  { prefix: 'typed-stream' },
  {
    log: {
      method: 'GET',
      path: '/:id',
      desc: 'Read a finite validated log',
      params: z.object({ id: z.string() }),
      stream: {
        item: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('line'), text: z.string() }),
          z.object({ kind: z.literal('complete'), count: z.number().int() }),
        ]),
        terminal: z.object({ kind: z.literal('complete') }).loose(),
        framing: 'item',
        completion: 'terminal',
        finalLine: 'require-newline',
        maxFrameBytes: 1_024,
      },
    },
  },
);
const typedService = implement(typedContract, {
  log: async function* ({ params }) {
    yield { kind: 'line' as const, text: `packed:${params.id}` };
    yield { kind: 'complete' as const, count: 1 };
    throw new Error('terminal completion consumed trailing producer work');
  },
});

const server = createServer({
  port: 0,
  services: [typedService],
  rawRoutes: [events, frames, sse, general],
});
const origin = `http://127.0.0.1:${server.port}`;

// 1. The headers arrive at open, before the source has produced anything. On a
//    quiet plane this is what separates "subscribed" from "not answering".
const controller = new AbortController();
const opened = await Promise.race([
  fetch(`${origin}/events`, { signal: controller.signal }),
  sleep(2_000).then(() => fail('a silent subscription never returned its headers')),
]);
if (opened.headers.get('content-type') !== 'application/x-ndjson') {
  fail(`wrong content type: ${opened.headers.get('content-type')}`);
}

// 2. The keep-alive really is on the wire — read as raw bytes, because the
//    reader is specified to skip exactly these frames.
const reader = opened.body?.getReader();
if (!reader) fail('the subscription had no body');
const decoder = new TextDecoder();
let pulses = 0;
const deadline = Date.now() + 600;
while (Date.now() < deadline) {
  const chunk = await Promise.race([
    reader.read(),
    sleep(1_000).then(() => ({ done: true, value: undefined })),
  ]);
  if (chunk.done) fail('the silent subscription was closed while it should have been idle');
  if (decoder.decode(chunk.value).trim() === '') pulses += 1;
}
if (pulses < 3) fail(`expected keep-alive frames while idle, saw ${pulses}`);

// 3. A disconnect closes the source, so a departed subscriber leaves no work.
controller.abort();
const closedInTime = await Promise.race([
  quiet.closed.then(() => true),
  sleep(5_000).then(() => false),
]);
if (!closedInTime) fail('a disconnect did not close the source');

// 4. The frames themselves, through the documented reader, with keep-alives
//    interleaved — the blank-line rule is under test, not assumed.
const options: ParseNDJSONOptions = {
  finalLine: 'require-newline',
  onParseError: (raw) => fail(`unreadable frame ${raw}`),
};
const received: unknown[] = [];
for await (const frame of parseNDJSON(await fetch(`${origin}/frames`), options)) {
  received.push(frame);
}
if (JSON.stringify(received) !== JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }])) {
  fail(`NDJSON round trip returned ${JSON.stringify(received)}`);
}

// 5. The SSE framing is the one the shipped `parseSSE` already reads.
const overSse: unknown[] = [];
for await (const frame of parseSSE(await fetch(`${origin}/sse`))) overSse.push(frame);
if (JSON.stringify(overSse) !== JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }])) {
  fail(`SSE round trip returned ${JSON.stringify(overSse)}`);
}

// 6. A declared header survives; the framing headers are the route's own.
const generalResponse = await fetch(`${origin}/general`);
if (generalResponse.headers.get('x-consumer') !== 'minimal')
  fail('declared header was dropped');
await generalResponse.body?.cancel();

// 7. One declaration drives server validation and the installed typed iterator.
const typedClient = createClient(typedContract, { baseUrl: origin });
const typed: AsyncIterableIterator<
  z.output<(typeof typedContract.endpoints.log.stream)['item']>
> = await typedClient.log({ id: 'finite' });
const typedValues: Array<z.output<(typeof typedContract.endpoints.log.stream)['item']>> = [];
for await (const value of typed) typedValues.push(value);
if (
  JSON.stringify(typedValues) !==
  JSON.stringify([
    { kind: 'line', text: 'packed:finite' },
    { kind: 'complete', count: 1 },
  ])
) {
  fail(`typed stream returned ${JSON.stringify(typedValues)}`);
}

// 8. The realtime refusal surface: the names resolve from the published
//    entrypoint and the recogniser behaves. A refusal is recognised before any
//    acknowledgement schema is consulted, so a consumer can classify one
//    without knowing anything about Zod's internals.
const report: RealtimeRejectionReport = {
  event: 'replicate',
  reason: 'invalid-arguments',
  message: 'refused by the peer',
  issues: [{ path: '0.v', code: 'invalid_value', message: 'Invalid input: expected 2' }],
};
const recognised = asRealtimeRejection({ [REALTIME_REJECTION_KEY]: report });
if (recognised?.reason !== 'invalid-arguments') fail('a refusal envelope was not recognised');
const issues: RealtimeRejectionIssue[] = recognised.issues ?? [];
if (issues[0]?.path !== '0.v') fail('the refused field did not survive the envelope');
if (asRealtimeRejection({ stored: true }) !== null)
  fail('an ordinary value read as a refusal');
const rejection = new RealtimeRequestRejectedError(
  'replicate',
  'invalid-arguments',
  'refused',
);
if (rejection.code !== 'REALTIME_REQUEST_REJECTED') fail('the rejection code is not stable');

await server.shutdown({ gracePeriodMs: 0 });
console.log('streaming subscription: ok');
