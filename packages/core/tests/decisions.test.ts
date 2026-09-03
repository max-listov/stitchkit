/**
 * An ordered chain of named policies.
 *
 * The two assertions that carry the whole surface: the trace is what **ran**,
 * not what was configured, and a chain that ends undecided raises instead of
 * inventing a verdict. Everything else here is a way of making one of those two
 * fail if it stops being true.
 */
import { describe, expect, test } from 'bun:test';
import {
  createDecisionPipeline,
  type DecisionPolicy,
  DecisionPolicyError,
  DecisionUndecidedError,
} from '../src/application/decisions';

interface Request {
  readonly actor: string;
  readonly amount: number;
}

/** A policy that records that it ran, so "did not run" is observable. */
function policy(
  id: string,
  answer: DecisionPolicy<Request>['decide'],
  ran: string[],
): DecisionPolicy<Request> {
  return {
    id,
    decide(input) {
      ran.push(id);
      return answer(input);
    },
  };
}

const request: Request = { actor: 'ops', amount: 10 };

describe('the chain stops at a verdict, and the trace says what ran', () => {
  test('a deny ends it, and the policies after it are not consulted', async () => {
    const ran: string[] = [];
    const pipeline = createDecisionPipeline<Request>([
      policy('defers', () => ({ outcome: 'defer' }), ran),
      policy('refuses', () => ({ outcome: 'deny', reason: 'over the limit' }), ran),
      policy('never-runs', () => ({ outcome: 'allow' }), ran),
    ]);

    const result = await pipeline.decide(request);

    expect(result.outcome).toBe('deny');
    expect(result.reason).toBe('over the limit');
    // Both halves: what ran, and — the sharper one — what did not.
    expect(ran).toEqual(['defers', 'refuses']);
    expect(result.trace).toEqual([
      { id: 'defers', outcome: 'defer' },
      { id: 'refuses', outcome: 'deny', reason: 'over the limit' },
    ]);
  });

  test('an allow ends it too', async () => {
    const ran: string[] = [];
    const pipeline = createDecisionPipeline<Request>([
      policy('defers', () => ({ outcome: 'defer' }), ran),
      policy('approves', () => ({ outcome: 'allow' }), ran),
      policy('never-runs', () => ({ outcome: 'deny', reason: 'unreachable' }), ran),
    ]);

    const result = await pipeline.decide(request);

    expect(result.outcome).toBe('allow');
    expect(ran).toEqual(['defers', 'approves']);
    expect(result.trace.map((entry) => entry.id)).toEqual(['defers', 'approves']);
  });

  test('the trace is what ran, not what was configured', async () => {
    // The negative control for the two tests above: a pipeline whose policies
    // all run produces a trace as long as the list, so a trace that were simply
    // a copy of the configuration would pass those and fail nothing.
    const ran: string[] = [];
    const pipeline = createDecisionPipeline<Request>([
      policy('a', () => ({ outcome: 'defer' }), ran),
      policy('b', () => ({ outcome: 'defer' }), ran),
      policy('c', () => ({ outcome: 'allow' }), ran),
    ]);
    const result = await pipeline.decide(request);
    expect(result.trace).toHaveLength(3);
    expect(pipeline.policyIds).toEqual(['a', 'b', 'c']);
  });

  test('a policy sees the input it was asked about', async () => {
    const seen: Request[] = [];
    const pipeline = createDecisionPipeline<Request>([
      {
        id: 'records',
        decide(input) {
          seen.push(input);
          return { outcome: 'allow' };
        },
      },
    ]);
    await pipeline.decide(request);
    expect(seen).toEqual([request]);
  });

  test('an asynchronous policy is awaited, in order', async () => {
    const ran: string[] = [];
    const pipeline = createDecisionPipeline<Request>([
      policy(
        'slow',
        async () => {
          await Bun.sleep(5);
          return { outcome: 'defer' };
        },
        ran,
      ),
      policy('fast', () => ({ outcome: 'allow' }), ran),
    ]);
    await pipeline.decide(request);
    expect(ran).toEqual(['slow', 'fast']);
  });
});

describe('an undecided chain is a defect, not an outcome', () => {
  test('every policy deferring raises, and the error carries what ran', async () => {
    const ran: string[] = [];
    const pipeline = createDecisionPipeline<Request>([
      policy('one', () => ({ outcome: 'defer' }), ran),
      policy('two', () => ({ outcome: 'defer' }), ran),
    ]);

    const failure = await pipeline.decide(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionUndecidedError);
    expect((failure as DecisionUndecidedError).trace.map((entry) => entry.id)).toEqual([
      'one',
      'two',
    ]);
    // "Nothing decided" is only actionable once the message says what ran.
    expect(String(failure)).toContain('one → two');
  });

  test('an empty pipeline raises rather than approving by default', async () => {
    const pipeline = createDecisionPipeline<Request>([]);
    await expect(pipeline.decide(request)).rejects.toBeInstanceOf(DecisionUndecidedError);
  });

  test('the result type carries no defer, so a caller cannot receive one', async () => {
    const pipeline = createDecisionPipeline<Request>([
      { id: 'approves', decide: () => ({ outcome: 'allow' }) },
    ]);
    const result = await pipeline.decide(request);
    // @ts-expect-error — `defer` is not one of the outcomes a result can carry
    const impossible: 'defer' = result.outcome;
    void impossible;
    expect(result.outcome).not.toBe('defer');
  });
});

describe('what the pipeline refuses to accept', () => {
  test('two policies under one id are refused at construction', () => {
    expect(() =>
      createDecisionPipeline<Request>([
        { id: 'limit', decide: () => ({ outcome: 'defer' }) },
        { id: 'limit', decide: () => ({ outcome: 'allow' }) },
      ]),
    ).toThrow(/two policies share the id "limit"/);
  });

  test('a policy with no id is refused', () => {
    expect(() =>
      createDecisionPipeline<Request>([{ id: '  ', decide: () => ({ outcome: 'allow' }) }]),
    ).toThrow(/needs a non-empty id/);
  });

  test.each([
    ['nothing at all', undefined],
    ['a bare string', 'allow'],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['a deny with no reason', { outcome: 'deny' }],
    ['a deny with an empty reason', { outcome: 'deny', reason: '' }],
  ])('a policy answering with %s is refused, naming the policy', async (_case, answer) => {
    const pipeline = createDecisionPipeline<Request>([
      { id: 'broken', decide: () => answer as any },
    ]);
    const failure = await pipeline.decide(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecisionPolicyError);
    expect((failure as DecisionPolicyError).policyId).toBe('broken');
  });

  test('a refusal without words is refused, because "denied" alone helps nobody', async () => {
    // Stated as its own test because it is the case a schema makes easy to get
    // wrong: `{ outcome: 'deny' }` is the shape a hurried policy writes, and
    // accepting it produces a refusal the person it refused cannot act on.
    const pipeline = createDecisionPipeline<Request>([
      { id: 'terse', decide: () => ({ outcome: 'deny' }) as any },
    ]);
    await expect(pipeline.decide(request)).rejects.toBeInstanceOf(DecisionPolicyError);
  });
});
