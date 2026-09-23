import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { normalizeError } from '../src/contract/normalize';
import {
  ApiError,
  zodIssues as barrelZodIssues,
  createClient,
  createHttpClient,
  type ZodIssueSummary,
} from '../src/entrypoints';
import {
  AppError,
  appError,
  defineContract,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
} from '../src/entrypoints/contract';
import { createServer, implement } from '../src/entrypoints/server';
import { formatZodError, zodIssues } from '../src/internal/zod-issues';
import { toolErrorFromResult } from '../src/tools/execute';

describe('stitch error registry', () => {
  test('STITCH_ERROR_STATUS maps codes → status (incl. METHOD_NOT_ALLOWED 405)', () => {
    expect(STITCH_ERROR_STATUS.METHOD_NOT_ALLOWED).toBe(405);
    expect(STITCH_ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(STITCH_ERROR_STATUS.VALIDATION_ERROR).toBe(400);
    expect(STITCH_ERROR_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
  });

  test('a coding-tool refusal keeps its declared status across a serialized envelope', () => {
    // `toolErrorFromResult` resolves the status from STITCH_ERROR_STATUS, and
    // the retention map behind it is in-process only — so an envelope that
    // crossed to another process (MCP, the CLI) is rebuilt from the wire alone.
    // While the coding-tool refusals kept their own private status map, every
    // code missing here came back 500: a declared 503 arrived as a server
    // fault. Measured before the fix: SANDBOX_UNAVAILABLE → 500.
    const rebuilt = (code: string) =>
      toolErrorFromResult(
        JSON.parse(JSON.stringify({ ok: false, code, details: { message: 'x' } })),
      ).status;
    expect(rebuilt('SANDBOX_UNAVAILABLE')).toBe(503);
    expect(rebuilt('SANDBOX_INSUFFICIENT')).toBe(503);
    expect(rebuilt('SPILL_REFERENCE_UNKNOWN')).toBe(404);
    // Controls: one framework code that was always mapped, and one app-owned
    // code that must still fall back to 500 rather than acquire a status.
    expect(rebuilt('WAIT_TIMEOUT')).toBe(408);
    expect(rebuilt('BOT_NOT_FOUND')).toBe(500);
  });

  test('isStitchErrorCode guards framework vs app codes', () => {
    expect(isStitchErrorCode('NOT_FOUND')).toBe(true);
    expect(isStitchErrorCode('METHOD_NOT_ALLOWED')).toBe(true);
    expect(isStitchErrorCode('BOT_NOT_FOUND')).toBe(false);
    for (const code of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(isStitchErrorCode(code)).toBe(false);
    }
  });

  test('prototype keys remain application errors with a valid 500 status', () => {
    for (const code of ['toString', 'constructor', 'valueOf', '__proto__']) {
      let error: unknown;
      try {
        appError(code);
      } catch (caught) {
        error = caught;
      }
      expect(AppError.is(error) && error.status).toBe(500);
      if (!AppError.is(error)) throw new Error('Expected AppError');
      expect(() => Response.json(error.toJSON(), { status: error.status })).not.toThrow();
    }
  });

  test('appError maps a stitch code to its status, an app code to 500', () => {
    let mna: unknown;
    try {
      appError('METHOD_NOT_ALLOWED', 'nope');
    } catch (e) {
      mna = e;
    }
    expect(AppError.is(mna) && mna.status).toBe(405);

    let app: unknown;
    try {
      appError('BOT_NOT_FOUND');
    } catch (e) {
      app = e;
    }
    expect(AppError.is(app) && app.status).toBe(500);
  });
});

describe('AppError', () => {
  test('hint field', () => {
    const err = new AppError(
      'NOT_FOUND',
      'missing',
      404,
      undefined,
      'Try list endpoint first',
    );
    expect(err.hint).toBe('Try list endpoint first');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
  });

  test('toJSON nests the public error payload', () => {
    const err = new AppError('ERR', 'msg', 500, { key: 'val' }, 'hint');
    const json = err.toJSON();
    expect(json.error.code).toBe('ERR');
    expect(json.error.message).toBe('msg');
    expect(json.error.details).toEqual({ key: 'val' });
    expect(json.error.hint).toBe('hint');
  });
});

describe('normalizeError', () => {
  test('AppError passthrough', () => {
    const err = new AppError('MY_ERROR', 'test', 422);
    expect(normalizeError(err)).toBe(err);
  });

  test('ZodError → VALIDATION_ERROR', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    if (result.success) throw new Error('Expected failure');

    const appErr = normalizeError(result.error);
    expect(appErr.code).toBe('VALIDATION_ERROR');
    expect(appErr.status).toBe(400);
    expect(appErr.message).toContain('name');
  });

  test('ZodError carries structured field issues in details', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 123, age: 'x' });
    if (result.success) throw new Error('Expected failure');

    const appErr = normalizeError(result.error);
    // Machine clients match on fields, not the text message.
    expect(appErr.details?.issues).toEqual([
      { path: 'name', code: 'invalid_type', message: expect.any(String) },
      { path: 'age', code: 'invalid_type', message: expect.any(String) },
    ]);
    // And the details survive the envelope.
    expect(appErr.toJSON().error.details).toBeDefined();
  });

  test('a realtime contract violation is scrubbed before it reaches the caller', async () => {
    const { realtimeContractViolation } = await import('../src/realtime/rejection');
    const parsed = z.object({ roomId: z.string() }).safeParse({ roomId: 42 });
    if (parsed.success) throw new Error('fixture must fail validation');
    const { error } = realtimeContractViolation({
      event: 'order:updated',
      direction: 'server-outbound',
      phase: 'arguments',
      reason: 'invalid-arguments',
      fault: 'local',
      cause: parsed.error,
    });
    const scrubbed = normalizeError(error);
    // The code and status survive (a server fault), but the event name, field
    // paths and fault attribution are internal shape and must not cross out.
    expect(scrubbed.code).toBe('REALTIME_CONTRACT_VIOLATION');
    expect(scrubbed.status).toBe(500);
    expect(scrubbed.message).toBe('Realtime contract violation');
    expect(scrubbed.message).not.toContain('order:updated');
    expect(scrubbed.details).toBeUndefined();
  });

  test('generic Error → INTERNAL_SERVER_ERROR with a generic message', () => {
    const err = normalizeError(new Error('Something broke'));
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.status).toBe(500);
    // The raw message is logged server-side, never sent to the client.
    expect(err.message).toBe('Internal server error');
  });

  test('string error → generic message', () => {
    const err = normalizeError('raw string');
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).toBe('Internal server error');
  });

  test('an internal message never leaks into the envelope', () => {
    const secret = `db://user:${'x'.repeat(300)}@host`;
    const err = normalizeError(new Error(secret));
    expect(err.message).toBe('Internal server error');
    expect(err.message).not.toContain('db://');
  });
});

describe('formatZodError', () => {
  test('formats path + message', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = schema.safeParse({ name: 123, age: 'old' });
    if (result.success) throw new Error('Expected failure');

    const formatted = formatZodError(result.error);
    expect(formatted).toContain('name');
    expect(formatted).toContain('age');
  });

  test('max 5 issues + suffix', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });
    const result = schema.safeParse({});
    if (result.success) throw new Error('Expected failure');

    const formatted = formatZodError(result.error);
    const lines = formatted.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(formatted).toContain('more issues');
  });
});

describe('zodIssues', () => {
  test('projects every issue to { path, code, message }', () => {
    const schema = z.object({ user: z.object({ name: z.string() }) });
    const result = schema.safeParse({ user: { name: 5 } });
    if (result.success) throw new Error('Expected failure');

    expect(zodIssues(result.error)).toEqual([
      { path: 'user.name', code: 'invalid_type', message: expect.any(String) },
    ]);
  });

  test('a root-level issue reports (root)', () => {
    const result = z.string().safeParse(123);
    if (result.success) throw new Error('Expected failure');
    expect(zodIssues(result.error)[0]?.path).toBe('(root)');
  });
});

/*
 * One projection, both sides — and reached through the door a browser may open.
 *
 * `zodIssues` is what a `VALIDATION_ERROR` already travels in, and until now the only entry that
 * exported it was `stitchkit/server`, which pulls `Bun.serve`. So a caller rendering
 * `ApiError.details.issues` had to hand-write the shape, and every consumer wrote its own — the
 * "N shapes of one thing" a contract-first framework exists to prevent, produced by the framework.
 *
 * The import below is deliberately from `../src` and not from `../src/internal/errors`: the barrel
 * IS the thing under test, and an import of the internal path would stay green with the export
 * removed. The comparison against a live server is the other half — an export that agreed with
 * nothing would be decoration.
 */
describe('the issue projection is reachable from the browser entry and equals the wire', () => {
  const contract = defineContract(
    { prefix: 'issues' },
    {
      create: {
        method: 'POST',
        path: '/create',
        desc: 'Create',
        input: z.object({ name: z.string().min(3), age: z.number().int() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  test('a server refusal carries exactly what the barrel projects locally', async () => {
    const server = createServer({
      port: 0,
      services: [implement(contract, { create: () => ({ ok: true }) })],
    });
    try {
      const api = createClient(
        contract,
        createHttpClient({ baseUrl: server.url, retry: { limit: 0 } }),
      );
      const bad = { name: 'ab', age: 'old' };
      const settled = await (
        api as unknown as Record<string, (a: unknown) => Promise<unknown>>
      )
        .create?.(bad)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (!ApiError.is(settled))
        throw new Error(`expected an ApiError, got ${String(settled)}`);

      // The denominator: a comparison of two empty lists would pass while proving nothing.
      // Typed through the exported type, which is half of what the export is for: a caller
      // reading `details.issues` had no public name for its element.
      const wire = (settled.details as { issues: ZodIssueSummary[] }).issues;
      expect(wire.length).toBeGreaterThan(1);

      const parsed = contract.endpoints.create.input.safeParse(bad);
      if (parsed.success) throw new Error('the probe value was supposed to be invalid');
      expect(barrelZodIssues(parsed.error)).toEqual(wire);
    } finally {
      await server.shutdown({ gracePeriodMs: 500 });
    }
  });
});

/*
 * A refused union names the branch and the field.
 *
 * Zod reports a failed `z.union` as one issue: code `invalid_union`, path `(root)`, message
 * `Invalid input`. Every per-branch reason it computed sits in `issue.errors` and was discarded
 * on the way to the wire. The result is a refusal that says a request was wrong and nothing about
 * what would have been right — and a caller holding a stale idea of the contract reads that as
 * "the source is broken", because no other reading is available. Two agents spent an evening on
 * exactly one such refusal.
 */
describe('a refused union names its branches', () => {
  const schema = z.object({
    payload: z.union([
      z.object({ kind: z.literal('a'), by: z.string() }),
      z.object({ kind: z.literal('b'), actor: z.string() }),
    ]),
  });

  function refusal() {
    const result = schema.safeParse({ payload: { kind: 'b', by: 'max' } });
    if (result.success) throw new Error('Expected failure');
    return result.error;
  }

  test('the union issue keeps its own path and gains every branch reason', () => {
    const [union] = zodIssues(refusal());
    expect(union?.path).toBe('payload');
    expect(union?.code).toBe('invalid_union');
    // The renamed field is the whole answer: branch 2 wants `actor`, the caller sent `by`.
    expect(union?.message).toContain('branch 1 at payload.kind');
    expect(union?.message).toContain('branch 2 at payload.actor');
  });

  test('each branch failure arrives as its own addressable issue', () => {
    expect(zodIssues(refusal()).slice(1)).toEqual([
      {
        path: 'payload.kind',
        code: 'invalid_value',
        message: expect.any(String),
        branch: 1,
      },
      {
        path: 'payload.actor',
        code: 'invalid_type',
        message: expect.any(String),
        branch: 2,
      },
    ]);
  });

  test('the text projection carries the branch too', () => {
    const formatted = formatZodError(refusal());
    expect(formatted).toContain('payload.actor (branch 2)');
  });

  test('an ordinary issue carries no branch at all', () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 5 });
    if (result.success) throw new Error('Expected failure');
    expect(zodIssues(result.error)).toEqual([
      { path: 'name', code: 'invalid_type', message: expect.any(String) },
    ]);
  });

  test('a discriminated union that cannot pick a branch is left alone', () => {
    const discriminated = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), by: z.string() }),
      z.object({ kind: z.literal('b'), actor: z.string() }),
    ]);
    const result = discriminated.safeParse({ kind: 'c' });
    if (result.success) throw new Error('Expected failure');
    const issues = zodIssues(result.error);
    // Zod already names the field and the accepted values here, and attaches no
    // branch errors to descend into — so there is nothing to add and one issue.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('kind');
    expect(issues[0]?.message).toContain("'a' | 'b'");
  });

  test('a nested union reports the inner branch, not just the outer one', () => {
    const nested = z.object({
      outer: z.union([
        z.object({ tag: z.literal('x'), inner: z.union([z.number(), z.boolean()]) }),
        z.object({ tag: z.literal('y') }),
      ]),
    });
    const result = nested.safeParse({ outer: { tag: 'x', inner: 'text' } });
    if (result.success) throw new Error('Expected failure');
    const paths = zodIssues(result.error).map((issue) => issue.path);
    expect(paths).toContain('outer.inner');
  });

  test('the envelope a caller receives carries the branch detail', () => {
    const settled = normalizeError(refusal());
    expect(settled.code).toBe('VALIDATION_ERROR');
    const wire = (settled.details as { issues: ZodIssueSummary[] }).issues;
    expect(wire.some((issue) => issue.branch === 2 && issue.path === 'payload.actor')).toBe(
      true,
    );
  });
});

/*
 * The answer was collected and then truncated away.
 *
 * The descent above ships the real path — but as one entry in a tree walk, and
 * the text projection prints the first five entries of that walk. For a union
 * over primitives (`z.json()`, or any recursive schema) the first entries are
 * the branches that failed on the type of the WHOLE value, all at the union's
 * own path, all saying the same thing. So a reader got `(root)` five times and
 * `...and 14 more issues`, while the line naming the field sat eighteenth. A
 * consuming session spent an hour on exactly that, one release after the path
 * became available — collecting the truth is not the same as presenting it.
 */
describe('the refusal presents the field it collected, not the first five lines of a tree walk', () => {
  function refusal() {
    // The reported shape: an optional field left `undefined` inside a value
    // checked by `z.json()`. Over HTTP it disappears in serialization, so the
    // same payload validates — which is why it was hunted in the wrong place.
    const result = z.json().safeParse({ nodes: [{ id: 'a', streams: undefined }] });
    if (result.success) throw new Error('Expected failure');
    return result.error;
  }

  test('the first line names the deepest field, not the path of the union', () => {
    const first = formatZodError(refusal()).split('\n')[0] ?? '';
    expect(first).toContain('nodes.0.streams');
    // The branch that got there is named too, so the reader can follow it back
    // into the schema rather than guessing which alternative was meant.
    expect(first).toMatch(/branch \d+ at nodes\.0\.streams/);
  });

  test('the branch that descended is described before the ones that failed on the whole value', () => {
    const first = formatZodError(refusal()).split('\n')[0] ?? '';
    const deep = first.indexOf('nodes.0.streams');
    const shallow = first.indexOf('received object');
    // Both present, then ordered. Asserting only the order let `-1` pass for a
    // line that did not name the field at all — the absent case reads as
    // "earliest", which is the opposite of what this test is for.
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(shallow).toBeGreaterThanOrEqual(0);
    // Ranked by how far each branch got: the five identical "expected
    // <primitive>, received object" lines are what crowded it out before.
    expect(deep).toBeLessThan(shallow);
  });

  test('no printed line repeats a path already printed', () => {
    const paths = formatZodError(refusal())
      .split('\n')
      .filter((line) => !line.startsWith('...and'))
      .map((line) => line.replace(/ \(branch \d+\)/, '').split(':')[0]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('every printed line carries a reason, including the deepest one', () => {
    // The line naming the field used to read `nodes.0.streams: Invalid input`:
    // the expansion limit had stopped the descent, and the bare sentence landed
    // on the one slot that mattered. The limit bounds the issue LIST; it does
    // not license a line that says nothing.
    for (const line of formatZodError(refusal()).split('\n')) {
      if (line.startsWith('...and')) continue;
      expect(line).not.toMatch(/: Invalid input$/);
    }
  });

  test('the structured projection still carries every branch, repeats included', () => {
    // The text drops repeated paths because a person gains nothing from them.
    // A machine addresses them by branch number, so `zodIssues` keeps all of
    // them — and the envelope carries what `zodIssues` returned.
    const all = zodIssues(refusal());
    const atUnionPath = all.filter((issue) => issue.path === '(root)');
    expect(atUnionPath.length).toBeGreaterThan(1);
    const wire = (normalizeError(refusal()).details as { issues: ZodIssueSummary[] }).issues;
    expect(wire).toHaveLength(all.length);
  });

  test('an error with no unions prints exactly what it printed before', () => {
    const result = z.object({ a: z.string(), b: z.number() }).safeParse({ a: 1, b: 'x' });
    if (result.success) throw new Error('Expected failure');
    expect(formatZodError(result.error)).toBe(
      [
        'a: Invalid input: expected string, received number',
        'b: Invalid input: expected number, received string',
      ].join('\n'),
    );
  });
});
