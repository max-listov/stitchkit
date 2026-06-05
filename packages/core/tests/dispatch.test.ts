import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import { createRetainedTopics } from '../src/retained';
import { implement } from '../src/server';
import { createContractDispatcher } from '../src/tools/dispatch';

const tasks = defineContract(
  { prefix: 'tasks' },
  {
    setDone: {
      method: 'POST',
      path: '/done',
      desc: 'Mark a task done (idempotent)',
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    start: {
      method: 'POST',
      path: '/start',
      desc: 'Start a one-shot side effect',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
    whoami: {
      method: 'GET',
      path: '/who',
      desc: 'Echo the transport tag',
      output: z.object({ source: z.string() }),
    },
  },
);

describe('createContractDispatcher — BYO-transport contract execution', () => {
  test('runs a method, validates input, returns the ok envelope', async () => {
    const svc = implement(tasks, {
      setDone: (_ctx) => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('setDone', { id: 'abc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ ok: true });
  });

  test('an invalid input is a VALIDATION_ERROR result, not a throw', async () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('setDone', {}); // missing id
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
  });

  test('an unknown method is a NOT_FOUND result', async () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('nope', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  test('a thrown AppError becomes a typed envelope (code preserved)', async () => {
    const svc = implement(tasks, {
      setDone: () => {
        throw new AppError('CONFLICT', 'already done', 409);
      },
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('setDone', { id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONFLICT');
  });

  test('the source tag reaches ctx.source', async () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('whoami', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ source: 'local-ws' });
  });

  test('a lifecycle beforeHandle gate rejects the call', async () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, {
      source: 'local-ws',
      lifecycle: {
        beforeHandle: () => {
          throw new AppError('FORBIDDEN', 'no scope', 403);
        },
      },
    });

    const result = await dispatcher.dispatch('setDone', { id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
  });

  test('afterToolCall hook fires with the resolved endpoint identity', async () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const calls: Array<{ name: string; key: string; ok: boolean }> = [];
    const dispatcher = createContractDispatcher(svc, {
      source: 'local-ws',
      hooks: {
        afterToolCall: (name, _args, result, _ms, _ctx, endpoint) => {
          calls.push({ name, key: endpoint.key, ok: result.ok });
        },
      },
    });

    await dispatcher.dispatch('setDone', { id: 'x' });
    expect(calls).toEqual([{ name: 'setDone', key: 'setDone', ok: true }]);
  });

  test('lists its method keys and rejects duplicate names across services', () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });
    expect([...dispatcher.methods].sort()).toEqual(['setDone', 'start', 'whoami']);

    // Two services that both define a `setDone` key collide.
    const other = implement(
      defineContract(
        { prefix: 'other' },
        {
          setDone: {
            method: 'POST',
            path: '/d',
            desc: 'dup',
            input: z.object({ id: z.string() }),
            output: z.object({ ok: z.boolean() }),
          },
        },
      ),
      { setDone: () => ({ ok: true }) },
    );
    expect(() => createContractDispatcher([svc, other], { source: 'local-ws' })).toThrow(
      /duplicate method/,
    );
  });

  test('per-call context overrides static context; neither can shadow source', async () => {
    const ctxContract = defineContract(
      { prefix: 'ctxcheck' },
      {
        peek: {
          method: 'GET',
          path: '/peek',
          desc: 'echo context',
          output: z.object({ source: z.string(), a: z.string(), b: z.string() }),
        },
      },
    );
    const svc = implement(ctxContract, {
      // RuntimeContext has an index signature, so static/per-call keys are readable.
      peek: (ctx) => ({ source: String(ctx.source), a: String(ctx.a), b: String(ctx.b) }),
    });
    const dispatcher = createContractDispatcher(svc, {
      source: 'local-ws',
      context: { a: 'static-a', b: 'static-b' },
    });

    // per-call `b` overrides static `b`; a hostile per-call `source` must NOT win.
    const result = await dispatcher.dispatch('peek', {}, { b: 'percall-b', source: 'evil' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ source: 'local-ws', a: 'static-a', b: 'percall-b' });
    }
  });

  test('a void-output method returns { status: "ok" }', async () => {
    const voidContract = defineContract(
      { prefix: 'voidc' },
      { ping: { method: 'POST', path: '/ping', desc: 'no output' } },
    );
    const svc = implement(voidContract, { ping: () => undefined });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('ping', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ status: 'ok' });
  });

  test('a declared null output is preserved, not replaced by status:ok', async () => {
    const nullContract = defineContract(
      { prefix: 'nullc' },
      { n: { method: 'GET', path: '/n', desc: 'null output', output: z.null() } },
    );
    const svc = implement(nullContract, { n: () => null });
    const dispatcher = createContractDispatcher(svc, { source: 'local-ws' });

    const result = await dispatcher.dispatch('n', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });
});

describe('idempotent metadata flows contract → MethodDef', () => {
  test('idempotent rides through to the resolved method', () => {
    const svc = implement(tasks, {
      setDone: () => ({ ok: true }),
      start: () => ({ ok: true }),
      whoami: (ctx) => ({ source: String(ctx.source) }),
    });
    expect(svc.methods.setDone?.idempotent).toBe(true);
    // unset stays undefined ("unknown" — a careful transport treats it as non-idempotent)
    expect(svc.methods.start?.idempotent).toBeUndefined();
  });
});

describe('createRetainedTopics', () => {
  test('replays nothing before a value is recorded', () => {
    const topics = createRetainedTopics<{ a: number }>();
    let got: number | undefined;
    topics.replay('a', (v) => {
      got = v;
    });
    expect(got).toBeUndefined();
    expect(topics.get('a')).toBeUndefined();
  });

  test('records, replays and reads the last value per topic', () => {
    const topics = createRetainedTopics<{ a: number; b: string }>();
    topics.record('a', 1);
    topics.record('a', 2); // last wins
    topics.record('b', 'hi');

    let a: number | undefined;
    topics.replay('a', (v) => {
      a = v;
    });
    expect(a).toBe(2);
    expect(topics.get('a')).toBe(2);
    expect(topics.get('b')).toBe('hi');
  });

  test('clear forgets one topic or all', () => {
    const topics = createRetainedTopics<{ a: number; b: number }>();
    topics.record('a', 1);
    topics.record('b', 2);

    topics.clear('a');
    expect(topics.get('a')).toBeUndefined();
    expect(topics.get('b')).toBe(2);

    topics.record('a', 9);
    topics.clear(); // all
    expect(topics.get('a')).toBeUndefined();
    expect(topics.get('b')).toBeUndefined();
  });
});
