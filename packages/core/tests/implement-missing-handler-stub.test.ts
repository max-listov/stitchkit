import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler } from '../src/server/create';
import {
  createImplement,
  createImplementRegistry,
  createScopedImplement,
  createScopedImplementRegistry,
  implement,
  implementRegistry,
} from '../src/server/implement';

/*
 * The invariant is right: a contract without its handler is a lie about the surface, and a
 * client sees an endpoint that is not there. What is wrong is the RADIUS on a dev stand.
 *
 * Adding an endpoint is two edits by construction — the contract and the handler — and an
 * editor saves one file at a time, so a watcher restarts on the first save. Between the two the
 * whole stand is down, for everyone on it. A project rule ("make both edits at once") cannot
 * outrun the filesystem.
 */

const memory = defineContract(
  { prefix: 'memory', scope: 'public' },
  {
    store: {
      method: 'POST',
      path: '/store',
      desc: 'Store one memory',
      input: z.object({ text: z.string() }),
      output: z.object({ stored: z.boolean() }),
    },
    recall: {
      method: 'GET',
      path: '/recall',
      desc: 'Recall one memory',
      output: z.object({ text: z.string() }),
    },
  },
);

const stored = { store: () => ({ stored: true }) };

describe('an unimplemented endpoint can be a refusal instead of a dead application', () => {
  test('without the option the application still refuses to start, with the same text', () => {
    expect(() =>
      // @ts-expect-error — exactness is a compile-time contract and stays one; this is the
      // loose-JavaScript path a transpile-only watcher actually takes.
      implementRegistry({ memory }, { memory: stored }),
    ).toThrow(/handlers for "memory" mismatch \(missing: recall; extra: none\)/);
  });

  test('with the stub policy the application starts and the endpoint refuses', async () => {
    const services = implementRegistry(
      { memory },
      // @ts-expect-error — see above: the type error is the point, not the failure mode.
      { memory: stored },
      { onMissingHandler: 'stub' },
    );
    const recall = services[0]?.methods.recall;
    if (!recall) throw new Error('Expected the stubbed endpoint to be mounted');
    let thrown: unknown;
    try {
      await recall.handler({ params: {}, input: undefined, source: 'http' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
    expect((thrown as Error).message).toContain('memory.recall');
  });

  test('the declared endpoint beside it is untouched', async () => {
    const services = implementRegistry(
      { memory },
      // @ts-expect-error — see above.
      { memory: stored },
      { onMissingHandler: 'stub' },
    );
    const store = services[0]?.methods.store;
    if (!store) throw new Error('Expected the declared endpoint to be mounted');
    expect(await store.handler({ params: {}, input: { text: 'x' }, source: 'http' })).toEqual({
      stored: true,
    });
  });

  /*
   * The save order cuts both ways, and so must the policy. Saving the handlers first leaves a
   * handler with no contract; a policy that only understood the missing direction would take
   * the stand down on every other edit.
   */
  test('the other save order — a handler with no contract — also keeps the stand up', () => {
    expect(() =>
      implementRegistry(
        { memory },
        // @ts-expect-error — the extra key is the whole scenario.
        { memory: { ...stored, recall: () => ({ text: 'x' }) }, notes: { write: () => ({}) } },
        { onMissingHandler: 'stub' },
      ),
    ).not.toThrow();
  });

  test('a contract whose handlers file does not exist yet is fully stubbed', () => {
    const services = implementRegistry(
      { memory },
      // @ts-expect-error — no handlers object at all for this contract.
      {},
      { onMissingHandler: 'stub' },
    );
    expect(Object.keys(services[0]?.methods ?? {}).sort()).toEqual(['recall', 'store']);
  });
});

/*
 * AGENTS.md names "a declared option that is accepted and then not honoured on some path"
 * as this repository's most repeated defect. Six binding forms accept this option; a test
 * on one of them proves one of them.
 */
describe('the stub policy is honoured on every binding form', () => {
  const forms: Array<[string, () => unknown]> = [
    ['implement', () => implement(memory, stored as never, { onMissingHandler: 'stub' })],
    [
      'createImplement',
      () => createImplement()(memory, stored as never, { onMissingHandler: 'stub' }),
    ],
    [
      'createScopedImplement',
      () =>
        createScopedImplement<{ public: object }>()(memory, stored as never, {
          onMissingHandler: 'stub',
        }),
    ],
    [
      'implementRegistry',
      () =>
        implementRegistry({ memory }, { memory: stored } as never, {
          onMissingHandler: 'stub',
        }),
    ],
    [
      'createImplementRegistry',
      () =>
        createImplementRegistry()({ memory }, { memory: stored } as never, {
          onMissingHandler: 'stub',
        }),
    ],
    [
      'createScopedImplementRegistry',
      () =>
        createScopedImplementRegistry<{ public: object }>()(
          { memory },
          { memory: stored } as never,
          {
            onMissingHandler: 'stub',
          },
        ),
    ],
  ];

  for (const [name, bind] of forms) {
    test(`${name} mounts the missing endpoint as a stub instead of throwing`, () => {
      const warned: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => {
        warned.push(parts.map(String).join(' '));
      };
      try {
        expect(bind).not.toThrow();
      } finally {
        console.warn = original;
      }
      // "Names itself in the log" is part of the request, not decoration: a stub
      // nobody can see is a hole nobody will close.
      expect(
        warned.some((line) => line.includes('[stitchkit]') && line.includes('memory.recall')),
      ).toBe(true);
    });
  }

  test('over HTTP the stub is a real 501, not a scrubbed 500', async () => {
    const services = implementRegistry({ memory }, { memory: stored } as never, {
      onMissingHandler: 'stub',
    });
    const handler = createHandler({ services });
    const response = await handler(new Request('http://localhost/memory/recall'));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });
});
