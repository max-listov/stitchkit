/**
 * The executor contract's schemas refuse what they do not declare: a hello
 * carries capabilities and statuses, never a path, an environment or a token.
 */
import { describe, expect, test } from 'bun:test';
import {
  defineAgentExecutorContract,
  type ExecutorHello,
  ExecutorHelloSchema,
  InteractionReplySchema,
  TurnReportSchema,
} from '../../src/entrypoints/agent-executor';

const hello: ExecutorHello = {
  protocol: 1,
  instance: 'instance-1',
  executorId: 'mac-of-a-member',
  engines: [
    {
      engine: 'claude-cli',
      version: '2.1.330',
      reconcile: 'client-id',
      models: { answer: 'not-asked' },
    },
  ],
  profiles: [
    {
      profileId: 'p-1',
      engine: 'claude-cli',
      login: { state: 'signed-in' },
      effectiveCredential: 'subscription',
      ownCredentials: ['ANTHROPIC_API_KEY'],
      planLimits: {
        answer: 'known',
        windows: [
          { name: 'five_hour', usedPercent: 12.5, resetsAt: '2026-11-24T05:00:00.000+08:00' },
        ],
        observedAt: '2026-11-24T01:00:00.000+08:00',
      },
    },
  ],
  resumable: [],
};

describe('the executor contract schemas', () => {
  test('a hello with its declared fields parses', () => {
    expect(ExecutorHelloSchema.parse(hello)).toEqual(hello);
  });

  test('an undeclared key anywhere in a hello is refused, a token or a path above all', () => {
    expect(ExecutorHelloSchema.safeParse({ ...hello, token: 'secret' }).success).toBe(false);
    const leaking = {
      ...hello,
      profiles: [{ ...hello.profiles[0], configDir: '/Users/someone/.claude' }],
    };
    expect(ExecutorHelloSchema.safeParse(leaking).success).toBe(false);
    const engine = { ...hello, engines: [{ ...hello.engines[0], env: { HOME: '/root' } }] };
    expect(ExecutorHelloSchema.safeParse(engine).success).toBe(false);
  });

  test('a hello takes the ids a report takes, and nothing unbounded', () => {
    const turn = (turnId: string) => ({
      turnId,
      threadId: 'th',
      turnOrdinal: 1,
      fence: 1,
      executorSeq: 0,
    });
    const report = (turnId: string) => ({
      turnId,
      threadId: 'th',
      turnOrdinal: 1,
      instance: 'i',
      fence: 1,
      executorSeq: 1,
      phase: 'dispatching',
      deltas: [],
    });
    for (const turnId of ['t'.repeat(256), 't'.repeat(257)]) {
      // Whatever a hello resumes, the turn's report accepts too — and the other way round.
      expect(
        ExecutorHelloSchema.safeParse({ ...hello, resumable: [turn(turnId)] }).success,
      ).toBe(TurnReportSchema.safeParse(report(turnId)).success);
    }
    expect(TurnReportSchema.safeParse(report('t'.repeat(257))).success).toBe(false);
    const many = <T>(count: number, item: T) => Array.from({ length: count }, () => item);
    for (const [field, over] of [
      ['resumable', { ...hello, resumable: many(4097, turn('t')) }],
      ['profiles', { ...hello, profiles: many(257, hello.profiles[0]) }],
      ['engines', { ...hello, engines: many(5, hello.engines[0]) }],
      [
        'model ids',
        {
          ...hello,
          engines: [
            { ...hello.engines[0], models: { answer: 'listed', ids: many(1025, 'm') } },
          ],
        },
      ],
      ['version', { ...hello, engines: [{ ...hello.engines[0], version: 'v'.repeat(257) }] }],
      [
        'credential names',
        { ...hello, profiles: [{ ...hello.profiles[0], ownCredentials: many(65, 'X') }] },
      ],
    ] as const) {
      expect(ExecutorHelloSchema.safeParse(over).success, field).toBe(false);
    }
  });

  test('models say listed, not asked or failed — never one value for three facts', () => {
    const models = (value: unknown) =>
      ExecutorHelloSchema.safeParse({
        ...hello,
        engines: [{ ...hello.engines[0], models: value }],
      }).success;
    expect(models({ answer: 'listed', ids: [] })).toBe(true);
    expect(models({ answer: 'listed', ids: ['a'] })).toBe(true);
    expect(models({ answer: 'not-asked' })).toBe(true);
    expect(models({ answer: 'failed', error: 'refused' })).toBe(true);
    expect(models(null)).toBe(false);
    expect(models([])).toBe(false);
    expect(models({ answer: 'failed' })).toBe(false);
  });

  test('a report under a phase the contract does not name, or cancelled, is refused', () => {
    const report = {
      turnId: 't',
      threadId: 'th',
      turnOrdinal: 1,
      instance: 'i',
      fence: 1,
      executorSeq: 1,
      phase: 'delivered',
      deltas: [],
    };
    expect(TurnReportSchema.safeParse(report).success).toBe(true);
    expect(TurnReportSchema.safeParse({ ...report, phase: 'cancelled' }).success).toBe(false);
  });

  test('a deny carries its message', () => {
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'deny' },
      }).success,
    ).toBe(false);
  });

  test('defineAgentExecutorContract declares exactly hello, claim, renew, report and release', () => {
    const contract = defineAgentExecutorContract({ scope: 'admin' });
    expect(Object.keys(contract.endpoints).sort()).toEqual([
      'claim',
      'hello',
      'release',
      'renew',
      'report',
    ]);
  });
});
