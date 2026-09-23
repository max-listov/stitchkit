/**
 * Compile-time contract of `withToolView` — ADR 0196.
 *
 * `bun test` does NOT pick this file up (its name carries no `.test.`
 * segment) — it is checked by `bun run check` (`tsc --noEmit`, tsconfig
 * `include: ["src", "tests"]`). Every `@ts-expect-error` below is an assertion:
 * if the helper stopped refusing that line, the directive would be unused and
 * the check would fail.
 */
import { z } from 'zod';
import {
  createContractFactory,
  defineContract,
  withToolView,
} from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';

const Full = z.object({
  rows: z.array(z.object({ id: z.string(), tags: z.array(z.object({ label: z.string() })) })),
});
const Card = z.object({
  rows: z.array(z.object({ id: z.string(), tags: z.array(z.string()) })),
});
const Query = z.object({ q: z.string(), include: z.array(z.string()).default(['all']) });

const endpoint = {
  method: 'GET',
  path: '/',
  desc: 'List rows',
  input: Query,
  output: Full,
  tool: { name: 'row_list' },
} as const;

// `project` is typed against the endpoint's own output and parsed input.
const contract = defineContract(
  { prefix: 'rows' },
  {
    list: withToolView(endpoint, {
      defaults: { include: [] },
      output: Card,
      project: (full, { input, source }) => {
        const query: string = input.q;
        const include: string[] = input.include;
        const transport: string = source;
        void query;
        void include;
        void transport;
        // @ts-expect-error — the full result has no such field
        void full.missing;
        return {
          rows: full.rows.map((row) => ({ id: row.id, tags: row.tags.map((t) => t.label) })),
        };
      },
    }),
  },
);

// The handler still sees the full, HTTP-typed contract — the view changes nothing there.
implement(contract, {
  list: (ctx) => {
    const include: string[] = ctx.input.include;
    void include;
    return { rows: [] };
  },
});

// A view keeps working through a scoped contract factory.
const { defineContract: defineScoped } = createContractFactory<'admin'>();
defineScoped(
  { prefix: 'scoped', scope: 'admin' },
  { list: withToolView(endpoint, { output: Card, project: () => ({ rows: [] }) }) },
);

withToolView(endpoint, {
  output: Card,
  // @ts-expect-error — a projection must return the view's shape
  project: (full) => ({ rows: full.rows }),
});

// A default names a key of the endpoint's input…
// @ts-expect-error
withToolView(endpoint, { defaults: { nope: 1 }, output: Card, project: () => ({ rows: [] }) });

// …and carries a value that key accepts.
// @ts-expect-error
withToolView(endpoint, { defaults: { q: 42 }, output: Card, project: () => ({ rows: [] }) });

// Reshaping inside the full schema needs no second one.
withToolView(endpoint, { project: (full) => ({ rows: full.rows.slice(0, 1) }) });

// A slice compiles when the full result fits the view…
withToolView(endpoint, { output: z.object({ rows: z.array(z.object({ id: z.string() })) }) });

// …and is refused as an endpoint when it does not.
// @ts-expect-error
defineContract({ prefix: 'slices' }, { list: withToolView(endpoint, { output: Card }) });

// An HTTP-only endpoint has no tool surface to answer.
// @ts-expect-error
withToolView({ ...endpoint, expose: ['HTTP'] } as const, {
  output: Card,
  project: () => ({ rows: [] }),
});

withToolView(
  // @ts-expect-error — a view needs the endpoint's full output to derive from
  { method: 'GET', path: '/', desc: 'No output' },
  { output: Card },
);
