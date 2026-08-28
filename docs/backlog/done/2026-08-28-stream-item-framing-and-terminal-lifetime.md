---
title: Schema-owned NDJSON framing and terminal-owned iterator lifetime
description: Allow adoption of typed bounded streams without changing an established item protocol or weakening completion guarantees.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
related: docs/backlog/done/2026-08-28-contract-first-bounded-streams.md
---

## Why

A consumer has a stable NDJSON protocol whose schema owns each complete frame and whose
terminal item ends the operation immediately. It needs the shared contract/reader/lifetime
mechanism without adding a second protocol envelope or retaining a parallel parser.
This is an adoption capability gap, not a claim that the currently documented boxed protocol
is broken. Existing callers must retain their declared behavior unless a breaking change is explicit.

Published0.68.3 reproduces three mismatches on Bun1.3.14 and Node26.7.0:

1. `createClient` stream rejects schema-valid unwrapped NDJSON with STREAM_PROTOCOL_ERROR.
   The descriptor only selects ndjson/sse; its reader requires ContractStreamFrameSchema.
2. A matching `terminal` item sets terminalSeen but does not end/abort the operation before
   yielding. With the consumer suspended at that yield, the connection remains owned until
   explicit return, a later protocol-end read or failure.
3. `parseNDJSON` accepts a valid final JSON document without a newline. There is no opt-in
   strict final-line requirement, so replacing a strict parser weakens truncation detection.

Source: packages/core/src/contract/define.ts, browser/contract-stream.ts,
server/contract-stream.ts, browser/stream.ts and internal/bounded-lines.ts.
0.68.3 did not change these files relative to0.68.2. No dependency source was modified.

## Reproduce with the published package

Install stitchkit0.68.3 and zod4.4.3 in a clean directory. Run as .mjs on Bun and Node:

```js
import {createClient,defineContract,parseNDJSON} from 'stitchkit';
import {z} from 'zod';
const item=z.object({kind:z.literal('complete')}).strict();
const contract=defineContract({prefix:'probe'},{read:{method:'GET',path:'/read',
  desc:'Finite item stream',stream:{item,terminal:item,maxFrameBytes:1024}}});
const collect=async text=>{const values=[];
  for await(const value of parseNDJSON(new Response(text)))values.push(value);
  return values;};
console.log('positive',await collect('{"kind":"complete"}\n'));
console.log('unterminated',await collect('{"kind":"complete"}'));
const raw=createClient(contract,{baseUrl:'http://example.invalid',fetch:async()=>
  new Response('{"kind":"complete"}\n',{headers:{'content-type':'application/x-ndjson'}})});
try {for await(const value of await raw.read())console.log(value);}
catch(error){console.log('raw',error.code);}
let signal;
const boxed=createClient(contract,{baseUrl:'http://example.invalid',fetch:async(_url,init)=>{
  signal=init.signal;
  return new Response(new ReadableStream({start(controller){controller.enqueue(
    new TextEncoder().encode('{"type":"data","data":{"kind":"complete"}}\n'));}}),
    {headers:{'content-type':'application/x-ndjson'}});
}});
const iterator=await boxed.read();
console.log(await iterator.next(),'abortedAtTerminalYield',signal.aborted);
await iterator.return();
console.log('abortedAfterReturn',signal.aborted);
```

Observed: positive and unterminated each yield one item; raw STREAM_PROTOCOL_ERROR;
abortedAtTerminalYield=false, abortedAfterReturn=true. No network server or private data needed.

## Result

A published, contract-first way to reuse bounded NDJSON parsing, schema validation and
iterator cleanup while preserving schema-owned frames and terminal-as-completion semantics.
Choose the smallest generic API: a framing/completion policy or an exported shared typed
reader/server composition surface. Do not add consumer identifiers or service-specific DTOs.

## Plan

- [x] Verify current public surfaces and document the smallest supported composition; if an
      existing path meets all guarantees, prove it with an installable example rather than add API.
- [x] Support schema-owned NDJSON items without mandatory data/error/end wrapping, with explicit
      error/EOF semantics and bounded request/frame/UTF-8 parsing on both server and client.
- [x] Make terminal-as-completion an explicit policy: cancel/close I/O before terminal delivery,
      including suspension at yield; do not require a subsequent next or return to free capacity.
- [x] Provide strict final-newline/truncation policy without silently changing permissive users.
- [x] Preserve quiet subscriptions, pre-header refusal, typed post-header failure, external abort,
      pending-next/return-before-next cleanup, pull backpressure and finite memory.
- [x] Document/publicly export the supported surface; release with clean packed Bun/Node and
      strict NodeNext/bundler composition gates. No private checkout imports or consumer parser clone.

## Acceptance

- [x] Valid schema-owned frames round-trip byte-for-byte with blank heartbeats; malformed,
      oversized, invalid UTF-8 and unterminated frames fail with distinct bounded outcomes.
- [x] Terminal yield already has released connection/admission; trailing data is not consumed.
- [x] Required terminal missing at EOF fails; indefinitely quiet streams remain until cancelled.
- [x] Deterministic real-reader/real-route regression and clean published-package proof on Bun/Node.
- [x] Exact release/tag/integrity/imports recorded; existing boxed framing remains explicitly supported.

## Что сделано

- [x] `EndpointStreamDescriptor` now has explicit envelope/item framing and
      stream-end/terminal completion policies; unsafe item/SSE and missing-terminal
      combinations are refused at declaration time.
- [x] The server writes schema-owned NDJSON items directly and stops its producer
      at the terminal item. The client releases its reader/request before yielding
      that terminal and reports `STREAM_TERMINAL_MISSING` on early EOF.
- [x] `parseNDJSON` and contract streams support opt-in
      `finalLine: 'require-newline'`; permissive final lines remain the default.
- [x] `packages/core/tests/contract-streaming.test.ts` covers declaration refusal,
      raw framing, terminal ownership, missing terminal, producer failure and
      strict/permissive final-line behavior through real streams and routes.
- [x] `packages/core/tests/openapi.test.ts` pins framing/completion/final-line
      metadata; packed minimal and Node fixtures compile and exercise the new
      public composition.
- [x] Full `bun run verify` passed for tree `17ba6fa76058`; exact-SHA CI run
      `33157551168` and release run `33157754062` passed.
- [x] Published `stitchkit@0.68.4`, tag `v0.68.4`, commit
      `6f13771f3bf62dc5700333d9e0ac73bb1c95bd69`, integrity
      `sha512-ajV2VFxDaFJ+XH7qq0WGYTfsebRyTlKUcO5MoPWFzKuD3G+J7yi4f+Eupz/R16yBUncXmsDlY/nDuEEjUOCHNw==`.
- [x] A clean registry install outside the checkout proved raw terminal framing,
      request release before terminal delivery, strict unterminated-line refusal
      and post-terminal completion on Bun 1.3.14 and Node 24.18.0.
