import { describe, expect, test } from 'bun:test';
import { ownedProviderStream } from '../src/agent-runtime/owned-provider-stream';
import {
  type AgentModelDriver,
  type AgentModelDriverStreamOutcome,
  type AgentModelRequest,
  type AgentModelStreamPart,
  AgentProviderStreamCutError,
  composeModelDrivers,
  wrapModelDriver,
} from '../src/entrypoints/agent-runtime';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';

function sampleRequest(): AgentModelRequest {
  return {
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    settings: {},
    correlation: {
      conversationId: 'conv-1',
      runId: 'run-1',
      attemptId: 'att-1',
      step: 1,
    },
  };
}

function reportedUsage(input = 10, output = 5) {
  return {
    inputTokens: { value: input, provenance: 'provider-reported' as const },
    outputTokens: { value: output, provenance: 'provider-reported' as const },
  };
}

function finishPart(
  finishReason: 'stop' | 'length' | 'tool-calls' = 'stop',
): AgentModelStreamPart {
  return {
    type: 'finish',
    finishReason,
    usage: reportedUsage(10, 5),
  };
}

describe('wrapModelDriver & composeModelDrivers', () => {
  test('threads per-stream state and invokes onClose exactly once on normal finish', async () => {
    const inner = createScriptedModelDriver({
      provider: 'test-provider',
      modelId: 'test-model',
      steps: [
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'hi' },
          { type: 'text-end', id: 't1' },
          finishPart('stop'),
        ],
      ],
    });

    const seenParts: string[] = [];
    const outcomes: Array<{ outcome: AgentModelDriverStreamOutcome; token: string }> = [];

    const wrapped = wrapModelDriver(inner, {
      beforeStream: (request) => ({
        token: `req:${request.correlation.attemptId}`,
        partCount: 0,
      }),
      transformRequest: (request, state) => ({
        ...request,
        settings: { ...request.settings, temperature: 0.25 },
        correlation: { ...request.correlation, attemptId: state.token },
      }),
      onPart: (part, state) => {
        state.partCount += 1;
        seenParts.push(`${state.token}:${part.type}:${state.partCount}`);
      },
      onClose: (outcome, state) => {
        outcomes.push({ outcome, token: state.token });
      },
    });

    expect(wrapped.provider).toBe('test-provider');
    expect(wrapped.modelId).toBe('test-model');

    const controller = new AbortController();
    const stream = await wrapped.stream(sampleRequest(), controller.signal);
    const collected: AgentModelStreamPart[] = [];
    for await (const part of stream.parts) {
      collected.push(part);
    }

    // Aborting after completion must not fire onClose a second time.
    controller.abort(new Error('late abort'));
    await Promise.resolve();

    expect(collected).toHaveLength(4);
    expect(inner.requests[0]?.settings.temperature).toBe(0.25);
    expect(inner.requests[0]?.correlation.attemptId).toBe('req:att-1');
    expect(seenParts).toEqual([
      'req:att-1:text-start:1',
      'req:att-1:text-delta:2',
      'req:att-1:text-end:3',
      'req:att-1:finish:4',
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({
      token: 'req:att-1',
      outcome: {
        status: 'finished',
        finishReason: 'stop',
        usage: reportedUsage(10, 5),
      },
    });
  });

  test('closes with errored when transformRequest throws without calling inner driver', async () => {
    let innerCalled = false;
    const inner: AgentModelDriver = {
      provider: 'p',
      modelId: 'm',
      async stream() {
        innerCalled = true;
        return {
          parts: (async function* () {
            // unreachable
          })(),
        };
      },
    };
    const boom = new Error('transform failed');
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      beforeStream: () => ({ id: 1 }),
      transformRequest: () => {
        throw boom;
      },
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    await expect(wrapped.stream(sampleRequest(), new AbortController().signal)).rejects.toBe(
      boom,
    );
    expect(innerCalled).toBe(false);
    expect(outcomes).toEqual([{ status: 'errored', error: boom }]);
  });

  test('closes with errored when inner driver.stream() throws', async () => {
    const boom = new Error('http 503');
    const inner = createScriptedModelDriver({ steps: [{ throw: boom }] });
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    await expect(wrapped.stream(sampleRequest(), new AbortController().signal)).rejects.toBe(
      boom,
    );
    expect(outcomes).toEqual([{ status: 'errored', error: boom }]);
  });

  test('closes with cancelled on pre-aborted signal without calling inner driver', async () => {
    let innerCalled = false;
    const inner: AgentModelDriver = {
      provider: 'p',
      modelId: 'm',
      async stream() {
        innerCalled = true;
        return {
          parts: (async function* () {
            // unreachable
          })(),
        };
      },
    };
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    const controller = new AbortController();
    controller.abort(new Error('already aborted'));

    await expect(wrapped.stream(sampleRequest(), controller.signal)).rejects.toThrow(
      'already aborted',
    );
    expect(innerCalled).toBe(false);
    expect(outcomes).toEqual([{ status: 'cancelled' }]);
  });

  test('closes with errored on mid-stream iterator throw', async () => {
    const boom = new Error('socket reset');
    const inner = createScriptedModelDriver({
      steps: [
        () => ({
          parts: (async function* () {
            yield { type: 'text-delta' as const, id: 't1', delta: 'partial' };
            throw boom;
          })(),
        }),
      ],
    });
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    const stream = await wrapped.stream(sampleRequest(), new AbortController().signal);
    const consume = async () => {
      for await (const _part of stream.parts) {
        // drain
      }
    };
    await expect(consume()).rejects.toBe(boom);
    expect(outcomes).toEqual([{ status: 'errored', error: boom }]);
  });

  test('closes inner iterator and calls onClose with errored when onPart throws', async () => {
    let innerReturned = false;
    const inner = createScriptedModelDriver({
      steps: [
        () => ({
          parts: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                async next() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: { type: 'text-delta' as const, id: 't1', delta: 'x' },
                    };
                  }
                  return { done: true, value: undefined };
                },
                async return() {
                  innerReturned = true;
                  return { done: true, value: undefined };
                },
              };
            },
          },
        }),
      ],
    });

    const partError = new Error('observer failure');
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      onPart: () => {
        throw partError;
      },
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    const stream = await wrapped.stream(sampleRequest(), new AbortController().signal);
    const consume = async () => {
      for await (const _part of stream.parts) {
        // unreachable
      }
    };
    await expect(consume()).rejects.toBe(partError);
    expect(innerReturned).toBe(true);
    expect(outcomes).toEqual([{ status: 'errored', error: partError }]);
  });

  test('closes with cancelled on early consumer break before finish and finished after finish', async () => {
    let returnCount = 0;
    const makeInner = (parts: AgentModelStreamPart[]): AgentModelDriver => ({
      provider: 'p',
      modelId: 'm',
      async stream() {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                async next() {
                  const value = parts[i];
                  i += 1;
                  if (value === undefined) return { done: true, value: undefined };
                  return { done: false, value };
                },
                async return() {
                  returnCount += 1;
                  return { done: true, value: undefined };
                },
              };
            },
          },
        };
      },
    });

    const beforeFinishOutcomes: AgentModelDriverStreamOutcome[] = [];
    const wrappedBefore = wrapModelDriver(
      makeInner([{ type: 'text-delta', id: 't1', delta: 'a' }, finishPart('stop')]),
      {
        onClose: (outcome) => {
          beforeFinishOutcomes.push(outcome);
        },
      },
    );
    const stream1 = await wrappedBefore.stream(sampleRequest(), new AbortController().signal);
    for await (const _part of stream1.parts) {
      break;
    }
    expect(beforeFinishOutcomes).toEqual([{ status: 'cancelled' }]);

    const afterFinishOutcomes: AgentModelDriverStreamOutcome[] = [];
    const wrappedAfter = wrapModelDriver(makeInner([finishPart('length'), { type: 'ping' }]), {
      onClose: (outcome) => {
        afterFinishOutcomes.push(outcome);
      },
    });
    const stream2 = await wrappedAfter.stream(sampleRequest(), new AbortController().signal);
    for await (const part of stream2.parts) {
      if (part.type === 'finish') break;
    }
    expect(afterFinishOutcomes).toEqual([
      {
        status: 'finished',
        finishReason: 'length',
        usage: reportedUsage(10, 5),
      },
    ]);
    expect(returnCount).toBe(2);
  });

  test('closes with errored on error part without finish and on silent stream cut', async () => {
    const providerErr = new Error('overloaded');
    const errorStream = createScriptedModelDriver({
      steps: [[{ type: 'error', error: providerErr }]],
    });
    const errorOutcomes: AgentModelDriverStreamOutcome[] = [];
    const wrappedError = wrapModelDriver(errorStream, {
      onClose: (outcome) => {
        errorOutcomes.push(outcome);
      },
    });
    const s1 = await wrappedError.stream(sampleRequest(), new AbortController().signal);
    for await (const _p of s1.parts) {
      // drain
    }
    expect(errorOutcomes).toEqual([{ status: 'errored', error: providerErr }]);

    const cutStream = createScriptedModelDriver({
      steps: [[{ type: 'text-delta', id: 't1', delta: 'half' }]],
    });
    const cutOutcomes: AgentModelDriverStreamOutcome[] = [];
    const wrappedCut = wrapModelDriver(cutStream, {
      onClose: (outcome) => {
        cutOutcomes.push(outcome);
      },
    });
    const s2 = await wrappedCut.stream(sampleRequest(), new AbortController().signal);
    for await (const _p of s2.parts) {
      // drain
    }
    expect(cutOutcomes).toHaveLength(1);
    expect(cutOutcomes[0]?.status).toBe('errored');
    if (cutOutcomes[0]?.status === 'errored') {
      expect(cutOutcomes[0].error).toBeInstanceOf(AgentProviderStreamCutError);
    }
  });

  test('closes with cancelled when AbortSignal fires even if stream is never iterated', async () => {
    const inner = createScriptedModelDriver({
      steps: [[finishPart('stop')]],
    });
    const closed = Promise.withResolvers<AgentModelDriverStreamOutcome>();
    let closeCount = 0;
    const wrapped = wrapModelDriver(inner, {
      onClose: (outcome) => {
        closeCount += 1;
        closed.resolve(outcome);
      },
    });

    const controller = new AbortController();
    await wrapped.stream(sampleRequest(), controller.signal);
    controller.abort(new Error('never iterated'));

    expect(await closed.promise).toEqual({ status: 'cancelled' });
    expect(closeCount).toBe(1);
  });

  test('composeModelDrivers applies decorators outer-to-inner and closes cleanly across layers', async () => {
    const inner = createScriptedModelDriver({
      steps: [[{ type: 'text-delta', id: 't1', delta: 'ok' }, finishPart('stop')]],
    });
    expect(composeModelDrivers(inner, [])).toBe(inner);

    const trace: string[] = [];
    const composed = composeModelDrivers(inner, [
      {
        beforeStream: () => {
          trace.push('A:before');
          return { label: 'A' };
        },
        transformRequest: (req, state) => {
          trace.push(`${state.label}:transform`);
          return { ...req, settings: { ...req.settings, maxOutputTokens: 100 } };
        },
        onPart: (part, state) => {
          trace.push(`${state.label}:part:${part.type}`);
        },
        onClose: (outcome, state) => {
          trace.push(`${state.label}:close:${outcome.status}`);
        },
      },
      {
        beforeStream: () => {
          trace.push('B:before');
        },
        transformRequest: (req) => {
          trace.push('B:transform');
          return {
            ...req,
            settings: {
              ...req.settings,
              maxOutputTokens: (req.settings.maxOutputTokens ?? 0) + 50,
            },
          };
        },
        onPart: (part) => {
          trace.push(`B:part:${part.type}`);
        },
        onClose: (outcome) => {
          trace.push(`B:close:${outcome.status}`);
        },
      },
      {
        beforeStream: () => {
          trace.push('C:before');
          return 42;
        },
        onPart: (part, num) => {
          trace.push(`C(${num}):part:${part.type}`);
        },
        onClose: (outcome, num) => {
          trace.push(`C(${num}):close:${outcome.status}`);
        },
      },
    ]);

    const stream = await composed.stream(sampleRequest(), new AbortController().signal);
    for await (const _part of stream.parts) {
      // drain
    }

    expect(inner.requests[0]?.settings.maxOutputTokens).toBe(150);
    expect(trace).toEqual([
      'A:before',
      'A:transform',
      'B:before',
      'B:transform',
      'C:before',
      'C(42):part:text-delta',
      'B:part:text-delta',
      'A:part:text-delta',
      'C(42):part:finish',
      'B:part:finish',
      'A:part:finish',
      'C(42):close:finished',
      'B:close:finished',
      'A:close:finished',
    ]);
  });

  test('composeModelDrivers unwinds outer layers when middle transformRequest fails', async () => {
    const inner = createScriptedModelDriver({ steps: [[finishPart('stop')]] });
    const trace: string[] = [];
    const boom = new Error('middle rejected');

    const composed = composeModelDrivers(inner, [
      {
        beforeStream: () => {
          trace.push('outer:before');
          return 'outer';
        },
        onClose: (outcome, tag) => {
          trace.push(`${tag}:close:${outcome.status}`);
        },
      },
      {
        beforeStream: () => {
          trace.push('middle:before');
        },
        transformRequest: () => {
          throw boom;
        },
        onClose: (outcome) => {
          trace.push(`middle:close:${outcome.status}`);
        },
      },
      {
        beforeStream: () => {
          trace.push('inner:before');
        },
        onClose: (outcome) => {
          trace.push(`inner:close:${outcome.status}`);
        },
      },
    ]);

    await expect(composed.stream(sampleRequest(), new AbortController().signal)).rejects.toBe(
      boom,
    );
    expect(inner.requests).toHaveLength(0);
    expect(trace).toEqual([
      'outer:before',
      'middle:before',
      'middle:close:errored',
      'outer:close:errored',
    ]);
  });

  test('preserves finished outcome and enriched metadata when abort fires immediately after finish (ownedProviderStream race)', async () => {
    const providerError = new Error('upstream degraded');
    const inner: AgentModelDriver = {
      provider: 'openrouter',
      modelId: 'openai/gpt-5-mini',
      async stream() {
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'error', error: providerError };
              yield {
                type: 'finish',
                finishReason: 'error',
                rawFinishReason: 'error_finish',
                usage: reportedUsage(120, 45),
                costDetails: { promptCostUsd: 0.001, outputCostUsd: 0.002, isByok: false },
                responseProvider: 'OpenAI',
                response: { id: 'resp-42', modelId: 'gpt-5-mini-2026' },
              };
              yield { type: 'ping' };
            },
          },
        };
      },
    };

    const seenContext: Array<{ provider: string; modelId: string }> = [];
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      beforeStream: (_req, _sig, context) => {
        seenContext.push(context);
        return context.modelId;
      },
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });

    const controller = new AbortController();
    const stream = await wrapped.stream(sampleRequest(), controller.signal);
    for await (const part of ownedProviderStream({
      stream: stream.parts,
      abort: () => controller.abort(new Error('consumer stopped after finish')),
      onCleanupFailure: () => undefined,
    })) {
      if (part.type === 'finish') break;
    }

    expect(seenContext).toEqual([{ provider: 'openrouter', modelId: 'openai/gpt-5-mini' }]);
    expect(outcomes).toEqual([
      {
        status: 'finished',
        finishReason: 'error',
        rawFinishReason: 'error_finish',
        usage: reportedUsage(120, 45),
        costDetails: { promptCostUsd: 0.001, outputCostUsd: 0.002, isByok: false },
        responseProvider: 'OpenAI',
        response: { id: 'resp-42', modelId: 'gpt-5-mini-2026' },
        error: providerError,
      },
    ]);
  });

  test('composeModelDrivers unwinds onClose in strict LIFO order (C -> B -> A) on mid-stream and un-iterated abort', async () => {
    const traceActive: string[] = [];
    const makeHangingInner = (): AgentModelDriver => ({
      provider: 'p',
      modelId: 'm',
      async stream(_req, signal) {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                async next() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: { type: 'text-delta' as const, id: 't1', delta: 'chunk' },
                    };
                  }
                  return new Promise<IteratorResult<AgentModelStreamPart>>((_res, rej) => {
                    if (signal.aborted) rej(signal.reason);
                    else
                      signal.addEventListener('abort', () => rej(signal.reason), {
                        once: true,
                      });
                  });
                },
                async return() {
                  return { done: true, value: undefined };
                },
              };
            },
          },
        };
      },
    });

    const makeLayers = (sink: string[]) =>
      ['A', 'B', 'C'].map((label) => ({
        onClose: (outcome: AgentModelDriverStreamOutcome) => {
          sink.push(`${label}:${outcome.status}`);
        },
      }));

    // 1. Mid-stream abort via ownedProviderStream (abort fires before iterator.return()).
    const controller1 = new AbortController();
    const composed1 = composeModelDrivers(makeHangingInner(), makeLayers(traceActive));
    const stream1 = await composed1.stream(sampleRequest(), controller1.signal);
    for await (const _part of ownedProviderStream({
      stream: stream1.parts,
      abort: () => controller1.abort(new Error('cancelled')),
      onCleanupFailure: () => undefined,
    })) {
      break;
    }
    expect(traceActive).toEqual(['C:cancelled', 'B:cancelled', 'A:cancelled']);

    // 2. Un-iterated stream abort also closes in strict LIFO order (C -> B -> A).
    const traceUniterated: string[] = [];
    const closedA = Promise.withResolvers<void>();
    const layers2 = ['A', 'B', 'C'].map((label) => ({
      onClose: (outcome: AgentModelDriverStreamOutcome) => {
        traceUniterated.push(`${label}:${outcome.status}`);
        if (label === 'A') closedA.resolve();
      },
    }));
    const controller2 = new AbortController();
    const composed2 = composeModelDrivers(
      createScriptedModelDriver({ steps: [[finishPart('stop')]] }),
      layers2,
    );
    await composed2.stream(sampleRequest(), controller2.signal);
    controller2.abort(new Error('never iterated'));
    await closedA.promise;
    expect(traceUniterated).toEqual(['C:cancelled', 'B:cancelled', 'A:cancelled']);
  });

  test('transformSignal tightens the inner signal without ever loosening the parent signal', async () => {
    const innerAbortReasons: unknown[] = [];
    const makeWaiter = (): AgentModelDriver => ({
      provider: 'p',
      modelId: 'm',
      async stream(_request, signal) {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise((_res, rej) => {
                    if (signal.aborted) {
                      innerAbortReasons.push(signal.reason);
                      rej(signal.reason);
                      return;
                    }
                    signal.addEventListener(
                      'abort',
                      () => {
                        innerAbortReasons.push(signal.reason);
                        rej(signal.reason);
                      },
                      { once: true },
                    );
                  }),
              };
            },
          },
        };
      },
    });

    // 1. Decorator tightens via its own AbortController -> aborts inner stream and closes as cancelled.
    const holdController = new AbortController();
    const outcomes1: AgentModelDriverStreamOutcome[] = [];
    const tightened = wrapModelDriver(makeWaiter(), {
      beforeStream: () => ({ holdController }),
      transformSignal: (_parent, state) => state.holdController.signal,
      onClose: (outcome) => {
        outcomes1.push(outcome);
      },
    });
    const parent1 = new AbortController();
    const stream1 = await tightened.stream(sampleRequest(), parent1.signal);
    const holdReason = new Error('hold expired');
    setTimeout(() => holdController.abort(holdReason), 10);
    await expect(
      (async () => {
        for await (const _part of stream1.parts) {
          // wait
        }
      })(),
    ).rejects.toBe(holdReason);
    expect(outcomes1).toEqual([{ status: 'cancelled' }]);
    expect(parent1.signal.aborted).toBe(false);

    // 2. Negative control: returning a never-aborted signal CANNOT loosen the parent signal.
    const neverAborted = new AbortController();
    const outcomes2: AgentModelDriverStreamOutcome[] = [];
    const cannotLoosen = wrapModelDriver(makeWaiter(), {
      transformSignal: () => neverAborted.signal,
      onClose: (outcome) => {
        outcomes2.push(outcome);
      },
    });
    const parent2 = new AbortController();
    const stream2 = await cannotLoosen.stream(sampleRequest(), parent2.signal);
    const parentReason = new Error('user cancelled');
    setTimeout(() => parent2.abort(parentReason), 10);
    await expect(
      (async () => {
        for await (const _part of stream2.parts) {
          // wait
        }
      })(),
    ).rejects.toBe(parentReason);
    expect(outcomes2).toEqual([{ status: 'cancelled' }]);
    expect(innerAbortReasons).toEqual([holdReason, parentReason]);
  });

  test('runs onClose with errored even when inner iterator.return() throws synchronously during onPart failure, and tags provider on stream-cut', async () => {
    const syncCleanupBoom = new Error('sync return throw');
    const inner: AgentModelDriver = {
      provider: 'acme-prov',
      modelId: 'm1',
      async stream() {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                async next() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: { type: 'text-delta' as const, id: 't1', delta: 'x' },
                    };
                  }
                  return { done: true, value: undefined };
                },
                return() {
                  throw syncCleanupBoom;
                },
              };
            },
          },
        };
      },
    };
    const onPartErr = new Error('decorator onPart failure');
    const outcomes: AgentModelDriverStreamOutcome[] = [];
    const wrapped = wrapModelDriver(inner, {
      onPart: () => {
        throw onPartErr;
      },
      onClose: (outcome) => {
        outcomes.push(outcome);
      },
    });
    const stream = await wrapped.stream(sampleRequest(), new AbortController().signal);
    await expect(
      (async () => {
        for await (const _part of stream.parts) {
          // unreachable
        }
      })(),
    ).rejects.toBe(onPartErr);
    expect(outcomes).toEqual([{ status: 'errored', error: onPartErr }]);

    // Silent stream cut carries inner driver's provider name on AgentProviderStreamCutError.
    const cutOutcomes: AgentModelDriverStreamOutcome[] = [];
    const cutDriver = wrapModelDriver(
      createScriptedModelDriver({
        provider: 'acme-prov',
        modelId: 'm1',
        steps: [[{ type: 'text-delta', id: 't1', delta: 'incomplete' }]],
      }),
      {
        onClose: (outcome) => {
          cutOutcomes.push(outcome);
        },
      },
    );
    const cutStream = await cutDriver.stream(sampleRequest(), new AbortController().signal);
    for await (const _part of cutStream.parts) {
      // drain
    }
    expect(cutOutcomes).toHaveLength(1);
    expect(cutOutcomes[0]?.status).toBe('errored');
    if (cutOutcomes[0]?.status === 'errored') {
      expect(cutOutcomes[0].error).toBeInstanceOf(AgentProviderStreamCutError);
      if (cutOutcomes[0].error instanceof AgentProviderStreamCutError) {
        expect(cutOutcomes[0].error.provider).toBe('acme-prov');
      }
    }
  });
});
