/**
 * Two releases meeting on the executor ↔ server contract (ADR 0334).
 *
 * Every object of the contract is strict, so a key one release adds is refused by an older
 * reader. `fixtures/executor-wire/<release>.json` keeps each message's JSON Schema as that
 * release declared it (`scripts/executor-wire-snapshot.ts`). Per pair of neighbouring snapshots
 * this file states what was added, proves the statement three ways — the declared shapes differ
 * by exactly that, the older schema refuses a real message carrying each addition, today's
 * schema accepts it — and holds the table of the API reference to the same list.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  InteractionReplySchema,
  ThreadClaimSchema,
  ThreadLeaseSchema,
  ThreadRenewSchema,
  TurnInterruptSchema,
  TurnOfferSchema,
  TurnReportAckSchema,
  TurnReportSchema,
} from '../../src/agent-executor/executor-contract';
import { ExecutorHelloAckSchema, ExecutorHelloSchema } from '../../src/agent-executor/hello';
import {
  ExecutorDeltaSchema,
  ExecutorStartupPhaseSchema,
} from '../../src/agent-executor/vocabulary';
import { addedWirePaths, wirePaths } from '../support/executor-wire-paths';

const FIXTURES = `${import.meta.dir}/../fixtures/executor-wire`;
const REFERENCE = `${import.meta.dir}/../../../../docs/api/reference.md`;

const DIRECTIONS = ['executor→server', 'server→executor'] as const;
type Direction = (typeof DIRECTIONS)[number];

const SnapshotSchema = z.record(
  z.enum(DIRECTIONS),
  z.record(z.string(), z.record(z.string(), z.unknown())),
);
type Snapshot = z.infer<typeof SnapshotSchema>;

function released(version: string): Snapshot {
  return SnapshotSchema.parse(JSON.parse(readFileSync(`${FIXTURES}/${version}.json`, 'utf8')));
}

/** Today's messages, under the names the snapshots use. */
const CURRENT_SCHEMAS: Record<Direction, Record<string, z.ZodType>> = {
  'executor→server': {
    hello: ExecutorHelloSchema,
    claim: ThreadClaimSchema,
    renew: ThreadRenewSchema,
    report: TurnReportSchema,
  },
  'server→executor': {
    helloAck: ExecutorHelloAckSchema,
    lease: ThreadLeaseSchema,
    reportAck: TurnReportAckSchema,
    offer: TurnOfferSchema,
    interrupt: TurnInterruptSchema,
    reply: InteractionReplySchema,
  },
};

const current: Snapshot = { 'executor→server': {}, 'server→executor': {} };
for (const direction of DIRECTIONS) {
  for (const [name, schema] of Object.entries(CURRENT_SCHEMAS[direction])) {
    current[direction][name] = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  }
}

function pathsOf(snapshot: Snapshot, direction: Direction): Set<string> {
  const paths = new Set<string>();
  for (const [name, schema] of Object.entries(snapshot[direction])) {
    for (const path of wirePaths(name, schema)) paths.add(path);
  }
  return paths;
}

const raw = { source: 'codex', type: 'record' };
const delta = { turnId: 't-1', itemId: 'i-1', raw };

/** One message of each kind that the oldest snapshot accepts: what an addition is added to. */
const BASELINE = {
  hello: {
    protocol: 1,
    instance: 'instance-1',
    executorId: 'executor-1',
    engines: [
      {
        engine: 'codex',
        version: '1.0.0',
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
      },
    ],
    profiles: [
      {
        profileId: 'p-1',
        engine: 'codex',
        login: { state: 'signed-in' },
        effectiveCredential: 'subscription',
        ownCredentials: [],
        planLimits: {
          answer: 'known',
          windows: [{ name: 'weekly', usedPercent: 10 }],
          observedAt: '2026-11-27T00:00:00.000Z',
        },
      },
    ],
    resumable: [],
  },
  report: {
    turnId: 't-1',
    threadId: 'th-1',
    turnOrdinal: 1,
    instance: 'instance-1',
    fence: 1,
    executorSeq: 1,
    phase: 'failed',
    deltas: [
      { type: 'usage', ...delta, inputTokens: 1 },
      { type: 'turn-end', ...delta, outcome: 'failed' },
    ],
    failure: { kind: 'timeout', message: 'no answer' },
  },
  approve: { turnId: 't-1', interactionId: 'r-1', reply: { kind: 'approve' } },
  deny: { turnId: 't-1', interactionId: 'r-1', reply: { kind: 'deny', message: 'no' } },
  offer: {
    turnId: 't-1',
    threadId: 'th-1',
    turnOrdinal: 1,
    fence: 1,
    input: [{ type: 'text', text: 'hello' }],
    inputDigest: 'sha256:abc',
  },
};

interface Addition {
  /** The path as `wirePaths` names it. */
  readonly path: string;
  /** The same addition as the API reference's table names it. */
  readonly documented: string;
  /** The message the addition travels in, and that message carrying it. */
  readonly message: string;
  readonly carrying: unknown;
  /** Non-strict `AgentMessagePartSchema` branches accept unknown keys on older readers; prove schema addition by a payload older ignores and today refuses. */
  readonly olderAcceptsInvalid?: unknown;
}

const acpProvider = { schemaVersion: 1, provider: 'acp', data: { kind: 'read' } };
const toolResultPart = {
  type: 'tool-result',
  callId: 'c-1',
  toolName: 'read_file',
  outcome: 'success',
  output: { ok: true },
};
const usage = (extra: Record<string, unknown>) => ({
  ...BASELINE.report,
  deltas: [{ type: 'usage', ...delta, inputTokens: 1, ...extra }, BASELINE.report.deltas[1]],
});
const reportWith = (deltas: unknown[]) => ({ ...BASELINE.report, deltas });
const offerWith = (input: unknown[]) => ({ ...BASELINE.offer, input });
const [engine] = BASELINE.hello.engines;
const [profile] = BASELINE.hello.profiles;
const capabilities = {
  runtimePolicyEnforcement: 'native',
  sessionApproval: true,
  interruptOnDeny: true,
  updatedToolInput: false,
  structuredInput: true,
  steer: true,
  fork: true,
  revert: true,
  compact: true,
  injectItems: true,
  backgroundWorkOutlivesTurn: false,
  multiThreadPerProcess: false,
  images: false,
  planLimits: 'pull',
};

const add = (
  path: string,
  documented: string,
  message: string,
  carrying: unknown,
  olderAcceptsInvalid?: unknown,
): Addition => ({
  path,
  documented,
  message,
  carrying,
  ...(olderAcceptsInvalid !== undefined && { olderAcceptsInvalid }),
});

/** What each release added to the wire, read against the snapshot of the release before it. */
const SKEW: readonly {
  readonly release: string;
  readonly olderSnapshot: string;
  readonly newerSnapshot: string | 'current';
  readonly added: Record<Direction, readonly Addition[]>;
}[] = [
  {
    release: '0.130.0',
    olderSnapshot: '0.129.0',
    newerSnapshot: '0.130.1',
    added: {
      'executor→server': [
        add('hello.engines[].capabilities', 'engines[].capabilities', 'hello', {
          ...BASELINE.hello,
          engines: [{ ...engine, capabilities }],
        }),
        add(
          'report.deltas[][type=status]',
          "deltas[].type = 'status'",
          'report',
          reportWith([{ type: 'status', ...delta, phase: 'spawning' }]),
        ),
        add(
          'report.deltas[][type=turn-end].threadDisposition',
          'turn-end.threadDisposition',
          'report',
          reportWith([
            { type: 'turn-end', ...delta, outcome: 'failed', threadDisposition: 'broken' },
          ]),
        ),
        add(
          'report.deltas[][type=usage].cacheCreationInputTokens',
          'usage.cacheCreationInputTokens',
          'report',
          usage({ cacheCreationInputTokens: 1 }),
        ),
        add(
          'report.deltas[][type=usage].modelUsage',
          'usage.modelUsage',
          'report',
          usage({ modelUsage: { 'model-1': { inputTokens: 1, outputTokens: 1 } } }),
        ),
        add(
          'report.deltas[][type=usage].thinkingTokens',
          'usage.thinkingTokens',
          'report',
          usage({ thinkingTokens: 1 }),
        ),
        add(
          'report.deltas[][type=usage].total',
          'usage.total',
          'report',
          usage({ total: { inputTokens: 1 } }),
        ),
        add(
          'report.deltas[][type=usage].totalTokens',
          'usage.totalTokens',
          'report',
          usage({ totalTokens: 1 }),
        ),
        add('report.failure.threadDisposition', 'failure.threadDisposition', 'report', {
          ...BASELINE.report,
          failure: { ...BASELINE.report.failure, threadDisposition: 'broken' },
        }),
      ],
      'server→executor': [
        add('reply.reply[kind=approve].scope', 'approve.scope', 'reply', {
          ...BASELINE.approve,
          reply: { kind: 'approve', scope: 'session' },
        }),
        add('reply.reply[kind=approve].updatedInput', 'approve.updatedInput', 'reply', {
          ...BASELINE.approve,
          reply: { kind: 'approve', updatedInput: { command: 'ls' } },
        }),
        add('reply.reply[kind=deny].interrupt', 'deny.interrupt', 'reply', {
          ...BASELINE.deny,
          reply: { ...BASELINE.deny.reply, interrupt: true },
        }),
      ],
    },
  },
  {
    release: '0.131.0',
    olderSnapshot: '0.130.1',
    newerSnapshot: '0.132.3',
    added: {
      'executor→server': [
        add('hello.profiles[].planLimits.plan', 'profiles[].planLimits.plan', 'hello', {
          ...BASELINE.hello,
          profiles: [{ ...profile, planLimits: { ...profile?.planLimits, plan: 'pro' } }],
        }),
        add(
          'hello.profiles[].planLimits.windows[].scope',
          'profiles[].planLimits.windows[].scope',
          'hello',
          {
            ...BASELINE.hello,
            profiles: [
              {
                ...profile,
                planLimits: {
                  ...profile?.planLimits,
                  windows: [{ name: 'weekly', usedPercent: 10, scope: 'model-1' }],
                },
              },
            ],
          },
        ),
      ],
      'server→executor': [],
    },
  },
  {
    release: '0.134.0',
    olderSnapshot: '0.132.3',
    newerSnapshot: '0.134.0',
    added: {
      'executor→server': [
        add(
          'report.deltas[][type=plan]',
          "deltas[].type = 'plan'",
          'report',
          reportWith([
            {
              type: 'plan',
              ...delta,
              action: 'set',
              entries: [{ content: 'Audit', status: 'in_progress', priority: 'high' }],
            },
          ]),
        ),
        add(
          'report.deltas[][type=tool-result].provider',
          'tool-result.provider',
          'report',
          reportWith([{ ...toolResultPart, ...delta, provider: acpProvider }]),
        ),
      ],
      'server→executor': [
        add(
          'offer.input[][type=text].provider',
          'input[type=text].provider',
          'offer',
          offerWith([{ type: 'text', text: 'hello', provider: acpProvider }]),
          offerWith([{ type: 'text', text: 'hello', provider: 'not-an-envelope' }]),
        ),
        add(
          'offer.input[][type=tool-result].provider',
          'input[type=tool-result].provider',
          'offer',
          offerWith([{ ...toolResultPart, provider: acpProvider }]),
          offerWith([{ ...toolResultPart, provider: 'not-an-envelope' }]),
        ),
      ],
    },
  },
  {
    // The release in work: a key added here is named in a new row of this table and of the
    // reference before it ships.
    release: 'unreleased',
    olderSnapshot: '0.134.0',
    newerSnapshot: 'current',
    added: { 'executor→server': [], 'server→executor': [] },
  },
];

/** The reference's table: release and direction → the additions its rows name. */
function documentedAdditions(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of readFileSync(REFERENCE, 'utf8').split('\n')) {
    const row =
      /^\| (\d+\.\d+\.\d+) \| (executor|server) → (executor|server) \| `\w+` \| (.+) \|$/.exec(
        line,
      );
    if (!row) continue;
    const key = `${row[1]} ${row[2]}→${row[3]}`;
    const named = [...(row[4] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    rows.set(key, [...(rows.get(key) ?? []), ...named]);
  }
  return rows;
}

describe('executor ↔ server version skew', () => {
  test('the oldest snapshot accepts every baseline message, so each refusal below has one cause', () => {
    const oldest = released('0.129.0');
    const accepts = (direction: Direction, message: string, value: unknown) =>
      z.fromJSONSchema(oldest[direction][message] ?? {}).safeParse(value).success;
    expect(accepts('executor→server', 'hello', BASELINE.hello)).toBe(true);
    expect(accepts('executor→server', 'report', BASELINE.report)).toBe(true);
    expect(accepts('server→executor', 'offer', BASELINE.offer)).toBe(true);
    expect(accepts('server→executor', 'reply', BASELINE.approve)).toBe(true);
    expect(accepts('server→executor', 'reply', BASELINE.deny)).toBe(true);
    // A restored schema is as strict as the release was: an invented key is refused.
    expect(accepts('executor→server', 'hello', { ...BASELINE.hello, invented: 1 })).toBe(
      false,
    );
  });

  test.each(SKEW)(
    'what $release added to the wire is exactly what a reader on $olderSnapshot refuses',
    (skew) => {
      const older = released(skew.olderSnapshot);
      const newer = skew.newerSnapshot === 'current' ? current : released(skew.newerSnapshot);
      for (const direction of DIRECTIONS) {
        const expected = skew.added[direction];
        // 1. The declared shapes differ by the stated additions, no more and no fewer; nothing left.
        expect(addedWirePaths(pathsOf(older, direction), pathsOf(newer, direction))).toEqual(
          expected.map((addition) => addition.path).sort(),
        );
        expect(addedWirePaths(pathsOf(newer, direction), pathsOf(older, direction))).toEqual(
          [],
        );
        // 2. Each addition, alone in a real message: older reader refuses (or ignores non-strict part keys), today's validates.
        for (const addition of expected) {
          const olderSchema = z.fromJSONSchema(older[direction][addition.message] ?? {});
          const todaySchema = CURRENT_SCHEMAS[direction][addition.message];
          const check = (ok: boolean | undefined, want: boolean) =>
            expect([addition.path, ok]).toEqual([addition.path, want]);
          check(todaySchema?.safeParse(addition.carrying).success, true);
          if (addition.olderAcceptsInvalid !== undefined) {
            check(olderSchema.safeParse(addition.carrying).success, true);
            check(olderSchema.safeParse(addition.olderAcceptsInvalid).success, true);
            check(todaySchema?.safeParse(addition.olderAcceptsInvalid).success, false);
          } else {
            check(olderSchema.safeParse(addition.carrying).success, false);
          }
        }
      }
    },
  );

  test('the last snapshot is today’s wire: nothing is added or removed unnamed', () => {
    const last = released('0.134.0');
    for (const direction of DIRECTIONS) {
      expect(Object.keys(current[direction]).sort()).toEqual(
        Object.keys(last[direction]).sort(),
      );
      expect([...pathsOf(current, direction)].sort()).toEqual(
        [...pathsOf(last, direction)].sort(),
      );
    }
  });

  test('the API reference names every addition under its release and direction, and nothing else', () => {
    const documented = documentedAdditions();
    const expected = new Map<string, string[]>();
    for (const skew of SKEW) {
      for (const direction of DIRECTIONS) {
        if (skew.added[direction].length === 0) continue;
        expected.set(
          `${skew.release} ${direction}`,
          skew.added[direction].map((addition) => addition.documented),
        );
      }
    }
    const sorted = (rows: Map<string, string[]>) =>
      [...rows].map(([key, names]) => [key, [...names].sort()] as const).sort();
    expect(sorted(documented)).toEqual(sorted(expected));
  });
});

describe('the phase of a status delta', () => {
  const status = (phase: unknown) => ({
    type: 'status',
    turnId: 't-1',
    itemId: 'i-1',
    raw: { source: 'codex', type: 'startup' },
    phase,
  });

  test('is an open bounded label: the three the drivers emit and any other are accepted, an empty or oversized one refused', () => {
    for (const phase of ['spawning', 'initializing', 'verifying', 'downloading-model']) {
      expect([phase, ExecutorStartupPhaseSchema.safeParse(phase).success]).toEqual([
        phase,
        true,
      ]);
      expect(ExecutorDeltaSchema.safeParse(status(phase)).success).toBe(true);
    }
    expect(ExecutorStartupPhaseSchema.parse('  verifying  ')).toBe('verifying');
    for (const phase of ['', '   ', 'x'.repeat(65), 7, undefined]) {
      expect(ExecutorStartupPhaseSchema.safeParse(phase).success).toBe(false);
      expect(ExecutorDeltaSchema.safeParse(status(phase)).success).toBe(false);
    }
  });

  test('is documented as the schema declares it, in the reference, the migration and the changelog', () => {
    const closedUnion = "'spawning' | 'initializing' | 'verifying'";
    const repository = `${import.meta.dir}/../../../..`;
    for (const file of ['docs/api/reference.md', 'docs/guide/upgrading.md', 'CHANGELOG.md']) {
      const text = readFileSync(`${repository}/${file}`, 'utf8');
      expect([file, text.includes(`phase: ${closedUnion}`)]).toEqual([file, false]);
      expect([file, text.includes('open label of 1–64 trimmed characters')]).toEqual([
        file,
        true,
      ]);
    }
  });
});
