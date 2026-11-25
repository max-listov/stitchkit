/**
 * Every timer option refuses a value past the timer ceiling where it is taken, by the one timer
 * rule (`assertTimerMs`), before anything starts. 2 ** 31 ms is one past `MAX_TIMER_MS`: a
 * `setTimeout` of it fires at once, so each of these options used to end its wait the moment it
 * began. Each case proves its option; the rule itself is proven in `abort-deadline-helpers`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { recordAgentRetryDecision } from '../src/agent-runtime/retry-policy';
import type { RealtimeClientTransport } from '../src/browser/realtime-client';
import { bindRealtimeClient } from '../src/entrypoints';
import { createMemoryAgentRuntimeStore } from '../src/entrypoints/agent-runtime';
import { agentControlRealtimeContract } from '../src/entrypoints/agent-runtime/browser';
import { AgentCodingToolLimitsSchema } from '../src/entrypoints/agent-runtime/coding-tools';
import { createAgentRaceBarrier } from '../src/entrypoints/agent-runtime/testing';
import {
  ApplicationRestartInputSchema,
  createBoundedAdmission,
  createDecisionPipeline,
} from '../src/entrypoints/application';
import { defineContract } from '../src/entrypoints/contract';
import { createManagedFileBoundary, waitForDirectory } from '../src/entrypoints/files';
import { createGoogleOidcClient, GoogleOidcError } from '../src/entrypoints/google';
import { defineEvents } from '../src/entrypoints/live';
import { ShutdownOptionsSchema } from '../src/entrypoints/server';
import { createTelegramBotTransport } from '../src/entrypoints/telegram';
import { runManagedResourceConformance } from '../src/entrypoints/testing';
import {
  createSecureClientMetadataFetcher,
  defineDownloadTool,
  defineViewFileTool,
  mountDownload,
  mountViewFile,
} from '../src/entrypoints/tools';
import { fetchGuarded } from '../src/internal/secure-fetch';
import { expectTimerRefusal, expectTimerRejection } from './support/timer-refusal';

const PAST = 2 ** 31;

describe('a timer option past the timer ceiling is refused where it is taken', () => {
  test('stitchkit/tools: the download and view-file tools, and the CIMD fetcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-timer-rule-'));
    try {
      const files = await createManagedFileBoundary({ root });
      expectTimerRefusal(
        () =>
          defineDownloadTool({
            description: 'Download a URL',
            identity: { serviceName: 'files', action: 'download' },
            input: z.object({ url: z.url() }),
            resolveUrl: ({ url }) => url,
            files,
            timeoutMs: PAST,
          }),
        'defineDownloadTool timeoutMs',
        PAST,
      );
      expectTimerRefusal(
        () =>
          defineViewFileTool({
            description: 'View media',
            identity: { serviceName: 'media', action: 'view' },
            timeoutMs: PAST,
          }),
        'defineViewFileTool timeoutMs',
        PAST,
      );
      const server = new McpServer({ name: 'timer-rule', version: '1' });
      expectTimerRefusal(
        () =>
          mountDownload(server, {
            description: 'Download a URL',
            inputSchema: { url: z.string() },
            resolveUrl: (args) => String(args.url),
            files,
            timeoutMs: PAST,
          }),
        'mountDownload timeoutMs',
        PAST,
      );
      expectTimerRefusal(
        () => mountViewFile(server, { timeoutMs: PAST }),
        'mountViewFile timeoutMs',
        PAST,
      );
      expectTimerRefusal(
        () => createSecureClientMetadataFetcher({ timeoutMs: PAST }),
        'cimd.timeoutMs',
        PAST,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the guarded fetch refuses its deadlines before it opens a connection', async () => {
    for (const option of ['timeoutMs', 'bodyTimeoutMs', 'idleTimeoutMs'] as const) {
      let opened = 0;
      await expectTimerRejection(
        fetchGuarded(new URL('http://127.0.0.1:9/never'), true, {
          [option]: PAST,
          transport: () => {
            opened += 1;
            return Promise.reject(new Error('opened'));
          },
        }),
        option,
        PAST,
      );
      expect(opened).toBe(0);
    }
  });

  test('stitchkit/contract: a stream endpoint lifetime and heartbeat', () => {
    for (const option of ['lifetimeMs', 'heartbeatMs'] as const) {
      expectTimerRefusal(
        () =>
          defineContract(
            { prefix: 'wait' },
            {
              tail: {
                method: 'GET',
                path: '/tail',
                desc: 'An open stream',
                stream: { item: z.object({ n: z.number() }), format: 'sse', [option]: PAST },
              },
            },
          ),
        `Contract "wait": streaming endpoint "tail" ${option}`,
        PAST,
      );
    }
  });

  test('stitchkit: a realtime request timeout, before the request is sent', async () => {
    let sent = 0;
    const transport: RealtimeClientTransport = {
      connected: true,
      on: () => () => undefined,
      emit: () => true,
      emitWithAck: () => {
        sent += 1;
        return new Promise(() => undefined);
      },
      onConnectionChange: () => () => undefined,
    };
    const client = bindRealtimeClient(agentControlRealtimeContract, transport);
    await expectTimerRejection(
      Promise.resolve().then(() =>
        client.request(
          'agent:control',
          {
            schemaVersion: 1,
            requestId: crypto.randomUUID(),
            operation: 'detach',
            conversationId: 'one',
          },
          { timeoutMs: PAST },
        ),
      ),
      'Realtime request "agent:control" timeoutMs',
      PAST,
    );
    expect(sent).toBe(0);
  });

  test('stitchkit/live: a waiting topic listener timeout', () => {
    expectTimerRefusal(
      () =>
        defineEvents(
          {},
          {
            t: {
              schema: z.object({}),
              mode: 'decision',
              whenAllDefer: 'allow',
              listenerTimeoutMs: PAST,
            },
          },
        ),
      '[stitchkit] defineEvents: topic "t" listenerTimeoutMs',
      PAST,
    );
  });

  test('stitchkit/application: a decision policy timeout, and an admission drain or run', async () => {
    expectTimerRefusal(
      () => createDecisionPipeline([], { policyTimeoutMs: PAST }),
      '[stitchkit] decision pipeline: policyTimeoutMs',
      PAST,
    );
    const admission = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
    const lease = admission.acquire();
    expect(lease.outcome).toBe('leased');
    await expectTimerRejection(
      admission.drain({ timeoutMs: PAST }),
      'drain timeoutMs',
      PAST,
      0,
    );
    // A refused drain changed nothing: the admission still accepts.
    expect(admission.getSnapshot().state).toBe('accepting');
    if (lease.outcome === 'leased') lease.lease.release();
    let ran = false;
    await expectTimerRejection(
      admission.run(
        undefined,
        () => {
          ran = true;
        },
        { timeoutMs: PAST },
      ),
      'run timeoutMs',
      PAST,
      0,
    );
    expect(ran).toBe(false);
  });

  test('stitchkit/application: a restart grace period, by its schema', () => {
    for (const option of ['gracePeriodMs', 'forceTimeoutMs'] as const) {
      expect(
        ApplicationRestartInputSchema.safeParse({ resourceId: 'r', [option]: PAST }).success,
      ).toBe(false);
    }
  });

  test('stitchkit/server: shutdown budgets, by their schema', () => {
    for (const option of [
      'gracePeriodMs',
      'realtimeCloseTimeoutMs',
      'forceTimeoutMs',
    ] as const) {
      expect(ShutdownOptionsSchema.safeParse({ [option]: PAST }).success).toBe(false);
      expect(ShutdownOptionsSchema.safeParse({ [option]: PAST - 1 }).success).toBe(true);
    }
  });

  test('stitchkit/google: a token exchange timeout is a misconfiguration, caused by the timer rule', () => {
    let thrown: unknown;
    try {
      createGoogleOidcClient({
        clientId: 'google-client',
        clientSecret: 'google-secret',
        allowedRedirectUris: ['https://app.example/callback'],
        timeoutMs: PAST,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GoogleOidcError);
    expect(thrown).toMatchObject({ code: 'MISCONFIGURED' });
    expect(thrown).toHaveProperty('cause', expect.any(RangeError));
  });

  test('stitchkit/testing: the managed resource conformance watchdog, before a fixture exists', async () => {
    let created = 0;
    await expectTimerRejection(
      runManagedResourceConformance({
        createFixture: () => {
          created += 1;
          throw new Error('created');
        },
        watchdogTimeoutMs: PAST,
      }),
      '[stitchkit] managed resource conformance watchdogTimeoutMs',
      PAST,
    );
    expect(created).toBe(0);
  });

  test('stitchkit/files: a directory settle pause', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-timer-rule-'));
    try {
      expectTimerRefusal(() => waitForDirectory(dir, { settleMs: PAST }), 'settleMs', PAST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stitchkit/telegram: the Bot API transport deadlines', () => {
    for (const option of [
      'connectAttemptMs',
      'connectBudgetMs',
      'responseTimeoutMs',
    ] as const) {
      expectTimerRefusal(() => createTelegramBotTransport({ [option]: PAST }), option, PAST);
    }
  });

  test('stitchkit/agent-runtime: a retry delay and a race barrier', async () => {
    await expectTimerRejection(
      recordAgentRetryDecision({
        store: createMemoryAgentRuntimeStore(),
        conversationId: 'c',
        attempt: 1,
        failure: { reason: 'rate-limited', retryable: true, evidence: 'status' },
        policy: { maxAttempts: 3, delayMs: () => PAST },
      }),
      'Retry delayMs',
      PAST,
      0,
    );
    expectTimerRefusal(
      () => createAgentRaceBarrier(PAST),
      'Agent race barrier timeoutMs',
      PAST,
    );
    // The coding tool's shell budgets are not timer options: the process group's deadline steps
    // through scheduleAt (coding-shell-native-owner.test.ts proves a budget past it).
    for (const option of ['shellTimeoutMs', 'shellTerminationGraceMs'] as const) {
      expect(AgentCodingToolLimitsSchema.shape[option].safeParse(PAST).success).toBe(true);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

/**
 * A hand-written check of a duration: `Number.isFinite(timeoutMs)`, `delayMs <= 0`, or a generic
 * helper (`assertPositiveSafeInteger('settleMs', …)`) applied to one. Each is a second copy of
 * `assertTimerMs` and, so far always, one without the timer ceiling: a value past
 * `MAX_TIMER_MS` passed it and fired at once. `assertTimerSeconds` is the same rule for a duration
 * in seconds, in the same file.
 */
const joinWrappedCalls = (source: string): string => source.replace(/\(\s*\n\s*/g, '(');

const durationByHand =
  /\bNumber\.is(?:Finite|Integer|SafeInteger)\(\s*[\w.?]*(?:Ms|Timeout|timeout|Delay|delay|grace)\s*\)|\b[\w.?]*(?:Ms|Timeout|Delay|grace)\s*<=?\s*0\b|\bassert(?!Timer(?:Ms|Seconds)\b)\w*\(\s*[`'"][^`'"]*(?:Ms|[tT]imeout|[dD]elay|[dD]eadline)\b/;

/**
 * A duration that is not a timer delay, or one whose owner already handles the ceiling — each
 * kept by name with its reason, so a new hand-written timer check fails here.
 */
const durationsThatAreNotTimerOptions: Record<string, string> = {
  // Ages and instants: compared with a clock, never handed to a timer.
  'agent-executor/plan-limits.ts: if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {':
    'an age',
  'agent-runtime/models.ts: if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0) {':
    'an age',
  'files/chunk-spool.ts: if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {':
    'an age',
  "internal/atomic-staging.ts: assertPositiveSafeInteger('olderThanMs', olderThanMs, RangeError);":
    'an age',
  "agent-runtime/openrouter-route.ts: assertPositiveSafeInteger('ttlMs', ttlMs);":
    'a cache expiry instant',
  "server/oauth/cimd.ts: assertPositiveInteger('cimd.cache.resolutionWindowMs', resolutionWindowMs);":
    'a counting window',
  "server/oauth/cimd.ts: assertNonNegativeInteger('cimd.cache.defaultTtlMs', policy.defaultTtlMs ?? 300_000);":
    'a cache expiry instant',
  "server/oauth/cimd.ts: assertNonNegativeInteger('cimd.cache.maxTtlMs', policy.maxTtlMs ?? 3_600_000);":
    'a cache expiry instant',
  "server/oauth/cimd.ts: assertNonNegativeInteger('cimd.cache.negativeTtlMs', policy.negativeTtlMs ?? 10_000);":
    'a cache expiry instant',
  // Waits measured against a clock in short polls, or handed to the database as text.
  'application/file-state-store.ts: if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0)':
    'a lock-wait deadline polled against the clock',
  "sync/server-store-postgres.ts: assertPositiveSafeInteger('[stitchkit] sync store: lockTimeoutMs',":
    "PostgreSQL's lock_timeout, not a JS timer",
  'server/oauth/cimd.ts: if (freshness.store && Number.isFinite(freshness.freshnessMs)) {':
    'a measured freshness',
  "tracking/server/active-interval.ts: if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs)) return null;":
    'a measured interval',
  "observability/event-loop-delay.ts: assertPositiveSafeInteger('windowMs', windowMs);":
    'a window of buckets, bounded by the bucket count',
  "observability/event-loop-delay.ts: assertPositiveSafeInteger('resolutionMs', resolutionMs);":
    'a histogram resolution',
  // Delays whose owner re-arms past the ceiling instead of refusing it.
  "process/group.ts: assertPositiveSafeInteger('Command deadline', timeoutMs, RangeError);":
    'a command budget past the ceiling, stepped by scheduleAt',
  "process/group.ts: assertPositiveSafeInteger('Command deadline', nextMs, RangeError);":
    'a command budget past the ceiling, stepped by scheduleAt',
  'process/launch.ts: assertPositiveSafeInteger(`Command ${name} deadline`, value, RangeError);':
    'a native command budget, stepped by scheduleAt in process/group.ts',
  "agent-runtime/schedule-records.ts: assertPositiveSafeInteger('Schedule delay', delay);":
    'a durable schedule, stepped by scheduleAt in agent-runtime/schedules.ts',
  // A domain range inside the timer range, answered with the owner's own error.
  'application/watch-hub-core.ts: if (!Number.isInteger(config.reconcileIntervalMs) ||':
    'a domain range of 10 to 3 600 000 ms',
  ...Object.fromEntries(
    [
      "browser/session-refresh-policy.ts: assertOptionInRange('refreshTimeoutMs', timeout, 1, 3_600_000);",
      "browser/session-refresh-policy.ts: assertOptionInRange('storageTimeoutMs', storageTimeout, 1, 3_600_000);",
      "browser/session-refresh-policy.ts: assertOptionInRange('storageRetryMs', storageRetryMs, 1, 3_600_000);",
      "browser/session-refresh-policy.ts: assertOptionInRange('refreshAhead.leadMs', leadMs, 1, 86_400_000);",
      "browser/session-refresh-policy.ts: assertOptionInRange('refreshAhead.cooldownMs', cooldownMs, 1, 3_600_000);",
      "service-host/launchd.ts: assertLaunchdWaitMs('settleTimeoutMs', settleTimeoutMs, false);",
      "service-host/launchd.ts: assertLaunchdWaitMs('pollIntervalMs', pollIntervalMs, false);",
      "service-host/launchd.ts: assertLaunchdWaitMs('stabilityMs', stabilityMs, true);",
      "service-host/launchd.ts: assertLaunchdWaitMs('startupTimeoutMs', startupTimeoutMs, false);",
      "service-host/launchd.ts: assertLaunchdWaitMs('bootoutSettleTimeoutMs', bootoutSettleTimeoutMs, false);",
      "service-host/systemd.ts: assertSystemdWaitMs('stabilityMs', stabilityMs, true);",
      "service-host/systemd.ts: assertSystemdWaitMs('pollIntervalMs', pollIntervalMs, false);",
      "service-host/systemd.ts: assertSystemdWaitMs('startupTimeoutMs', startupTimeoutMs, false);",
    ].map((line) => [line, 'a domain range of at most 86 400 000 ms']),
  ),
  // Manual time: a fake clock that never reaches a platform timer.
  "testing/manual-clock.ts: if (!Number.isFinite(startMs)) throw new RangeError('startMs must be a finite number');":
    'manual time',
  "testing/manual-clock.ts: assertPositiveSafeInteger('holdLimitMs', holdLimitMs);":
    'manual time',
  "testing/manual-clock.ts: assertPositiveSafeInteger('stepMs', stepMs);": 'manual time',
  "testing/manual-clock.ts: assertPositiveSafeInteger('limitMs', limitMs);": 'manual time',
};

test('a timer duration is checked by assertTimerMs, never by hand', () => {
  for (const form of [
    'if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {',
    'if (!Number.isInteger(policyTimeoutMs) || policyTimeoutMs <= 0) {',
    "assertPositiveSafeInteger('settleMs', settleMs);",
    "assertPositiveNumber('cimd.timeoutMs', policy.timeoutMs ?? DEFAULT_CIMD_TIMEOUT_MS);",
    "assertPositiveSafeInteger('Agent race barrier timeoutMs', timeoutMs);",
    'if (grace !== undefined && (!Number.isSafeInteger(grace) || grace < 0)) {',
  ]) {
    expect(durationByHand.test(form), form).toBe(true);
  }
  for (const form of [
    "assertTimerMs('settleMs', settleMs);",
    "assertTimerSeconds('timeoutSec', timeoutSec);",
    'if (decision.delayMs > 0) {',
    'if (delay <= 0) return;',
    "assertPositiveSafeInteger('maxBytes', maxBytes);",
  ]) {
    expect(durationByHand.test(form), form).toBe(false);
  }
  // A call the formatter wrapped after its opening parenthesis is read as one line: otherwise
  // `assertPositiveSafeInteger(\n  'lockTimeoutMs', …` would pass unseen once its line grew long.
  expect(
    durationByHand.test(joinWrappedCalls("assertPositiveSafeInteger(\n  'settleMs',")),
  ).toBe(true);
  const found = sourceFiles(join(import.meta.dir, '..', 'src')).flatMap((path) =>
    joinWrappedCalls(readFileSync(path, 'utf8'))
      .split('\n')
      .filter((line) => durationByHand.test(line))
      .map((line) => `${path.slice(path.indexOf('/src/') + 5)}: ${line.trim()}`),
  );
  expect(found.filter((line) => !(line in durationsThatAreNotTimerOptions))).toEqual([]);
  // Every exception still exists: a stale one would hide the next check written in its place.
  expect(
    Object.keys(durationsThatAreNotTimerOptions).filter((line) => !found.includes(line)),
  ).toEqual([]);
});

/**
 * A Zod field that is a timer delay states the timer ceiling. A schema keeps its own
 * `ZodError` (ADR 0320), but a value past `MAX_TIMER_MS` still fires at once.
 */
test('a timer field of a schema states the timer ceiling', () => {
  const field = /\b(\w+Ms)\s*:\s*z((?:\s*\.\w+\((?:[^()]|\([^()]*\))*\))+)/g;
  // Measurements, instants and durations that never become a timer delay.
  const notTimers = new Set([
    'durationMs',
    'elapsedMs',
    'ttftMs',
    'queueWaitMs',
    'lateByMs',
    'stopDurationMs',
    'expiresAtMs',
    'delayMs', // a recorded observation of a delay
    'maxSnapshotAgeMs', // an age
    'drainFloorMs', // a declared deployment fact, read by the operator
    'afterMs', // a durable schedule, stepped by scheduleAt
    'everyMs',
    'intervalMs',
    'shellTimeoutMs', // a native command budget, stepped by scheduleAt
    'shellTerminationGraceMs',
  ]);
  const unbounded = sourceFiles(join(import.meta.dir, '..', 'src')).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(field)]
      .filter(([, name, chain]) => !notTimers.has(name ?? '') && !/\.max\(/.test(chain ?? ''))
      .map(([, name]) => `${path.slice(path.indexOf('/src/') + 5)}: ${name}`),
  );
  expect(unbounded).toEqual([]);
});
