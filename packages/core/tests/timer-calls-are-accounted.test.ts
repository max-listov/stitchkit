/**
 * Every place the source hands a delay to a timer, accounted for by where that delay comes from.
 *
 * Whether an option flows into a timer is not something a pattern can follow: it passes through
 * defaults, clocks, helpers and other modules. So the timer calls themselves are counted, file by
 * file, each file with the reason its delays are bounded: a constant, an option refused by the one
 * timer rule (`assertTimerMs`) where it is taken, a schema stating `MAX_TIMER_MS`, a domain range
 * inside the timer range, or a wait re-armed in steps of the ceiling. A new timer call changes a
 * count and fails here until its delay is accounted for — and an option that reaches it is proven
 * in `timer-options-checked-where-taken` or `timer-options-one-rule`.
 *
 * The boundary: `withSignalDeadline`, `withIdleDeadline` and `startIdleTimer` are not counted —
 * they apply the rule themselves. A deadline computed from two bounded values (grace plus force)
 * is waited for through `scheduleAt`, in steps of the ceiling, and counted where it steps.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A call, with or without type arguments (`withDeadline<Answer>(…)`); the declaration of the pause or
 * the deadline itself is not a call.
 */
const TIMER_CALL =
  /\b(?:setTimeout|setInterval)\(|\bAbortSignal\.timeout\(|(?<!function\s+)\b(?:sleep|withDeadline)(?:<[^()]*>)?\(/g;

const RULE = 'options refused by assertTimerMs where they are taken';

/** File → how many timer calls it makes, and why each delay stays inside the timer range. */
const timerCalls: Record<string, { calls: number; delays: string }> = {
  'agent-executor/claude-sdk/session.ts': {
    calls: 1,
    delays:
      'constant ENGINE_EXIT_WAIT_MS (10 s) for owned Claude Code processes to exit on close',
  },
  'agent-executor/codex/connect.ts': {
    calls: 1,
    delays: 'constant poll backoff (15–50 ms) while waiting for unix-listen socket',
  },
  'agent-executor/codex/thread-open.ts': {
    calls: 1,
    delays:
      'constant ABANDONED_TURN_MS (5 s) for the reply of a turn/start abandoned by abort',
  },
  'agent-executor/codex/unix-socket.ts': {
    calls: 1,
    delays: 'constant CLOSE_GRACE_MS (250 ms) after sending WebSocket Close frame',
  },
  'agent-executor/testing/conformance-support.ts': {
    calls: 1,
    delays: 'constant CONFORMANCE_WAIT_MS (10 s) bounding each lifecycle check',
  },
  'agent-executor/testing/conformance.ts': { calls: 1, delays: 'a constant poll' },
  'agent-executor/json-rpc-peer.ts': {
    calls: 1,
    delays: `requestTimeoutMs, timeoutMs: ${RULE}`,
  },
  'agent-executor/testing/fake-claude-engine.ts': {
    calls: 1,
    delays: 'a scripted test pause',
  },
  'agent-runtime/children-state.ts': {
    calls: 2,
    delays:
      'constant CHILD_HOST_BOUND_MS: a stop, a probe and every other question to a child host',
  },
  'agent-runtime/coordinator.ts': {
    calls: 1,
    delays: `close gracePeriodMs, forceTimeoutMs: ${RULE}`,
  },
  'agent-runtime/fault-bench.ts': {
    calls: 2,
    delays:
      'scripted milliseconds by schema with MAX_TIMER_MS; a token pace from tokensPerSecond',
  },
  'agent-runtime/invocations.ts': { calls: 1, delays: 'timeoutMs by schema, at most an hour' },
  'agent-runtime/openrouter-models.ts': { calls: 1, delays: `timeoutMs: ${RULE}` },
  'agent-runtime/owned-provider-stream.ts': { calls: 1, delays: 'constant cleanup budget' },
  'agent-runtime/postgres-transactions.ts': { calls: 1, delays: 'jitter under 200 ms' },
  'agent-runtime/run-step-spend.ts': { calls: 1, delays: `stepSpendTimeoutMs: ${RULE}` },
  'agent-runtime/run-store-retry.ts': { calls: 1, delays: 'constant retry table' },
  'agent-runtime/runtime-admission-gate.ts': {
    calls: 1,
    delays: `runtime close forceTimeoutMs: ${RULE}`,
  },
  'agent-runtime/runtime-internals.ts': {
    calls: 2,
    delays: `idleTimeoutMs, maxDurationMs: ${RULE}`,
  },
  'agent-runtime/sandbox-broker.ts': { calls: 1, delays: 'constant' },
  'agent-runtime/schedules.ts': { calls: 1, delays: 'stepped by scheduleAt' },
  'agent-runtime/terminal-commit.ts': { calls: 1, delays: 'constant retry table' },
  'agent-runtime/testing.ts': { calls: 1, delays: `race barrier timeoutMs: ${RULE}` },
  'application/admission-run.ts': { calls: 1, delays: `run timeoutMs: ${RULE}` },
  'application/admission.ts': { calls: 1, delays: `drain timeoutMs: ${RULE}` },
  'application/change-subscription.ts': {
    calls: 7,
    delays:
      'timeoutMs and reconcileIntervalMs: a domain range of at most an hour; retry by BackoffPolicySchema',
  },
  'application/decisions.ts': { calls: 1, delays: `policyTimeoutMs: ${RULE}` },
  'application/diagnostic-journal-manager.ts': { calls: 1, delays: `timeoutMs: ${RULE}` },
  'application/directory-inbox-delivery.ts': {
    calls: 2,
    delays: 'a quarter of leaseMs, by schema with MAX_TIMER_MS',
  },
  'application/directory-inbox.ts': {
    calls: 1,
    delays: 'pollIntervalMs by schema with MAX_TIMER_MS',
  },
  'application/grammy.ts': { calls: 1, delays: 'a macrotask' },
  // kernel-restart, kernel-rollback and the force sweep wait for grace plus force through
  // `scheduleAt` (internal/timers.ts): in steps, so they make no timer call of their own.
  'application/kernel-shutdown.ts': {
    calls: 1,
    delays: 'the grace deadline, gracePeriodMs by schema with MAX_TIMER_MS',
  },
  'application/notification-outbox.ts': {
    calls: 1,
    delays: 'pollIntervalMs by schema with MAX_TIMER_MS',
  },
  'application/watch-hub-core.ts': {
    calls: 4,
    delays: `holdMs: ${RULE}; reconcileIntervalMs a domain range; retry by BackoffPolicySchema; constant`,
  },
  'browser/cancellation.ts': {
    calls: 1,
    delays: `client, endpoint and request timeout: ${RULE}`,
  },
  'browser/chunked-upload.ts': {
    calls: 1,
    delays: `retryDelayMs: ${RULE}; doubled per retry up to MAX_TIMER_MS`,
  },
  'browser/client-executors.ts': { calls: 1, delays: 'constant replay backoff' },
  'browser/resumable.ts': { calls: 1, delays: 'retry by BackoffPolicySchema' },
  'browser/session-refresh-policy.ts': { calls: 1, delays: 'a domain range of at most a day' },
  'browser/socket-io-connection.ts': {
    calls: 1,
    delays: `reconnectOnServerDisconnect: ${RULE}`,
  },
  'device-relay/agent.ts': {
    calls: 1,
    delays: `heartbeatIntervalMs, leaseTtlMs: ${RULE}`,
  },
  'device-relay/hub-dispatch.ts': {
    calls: 2,
    delays: `timeoutMs, openTimeoutMs, defaultRpcTimeoutMs: ${RULE}`,
  },
  'device-relay/hub.ts': {
    calls: 1,
    delays: `leaseSweepIntervalMs, leaseTtlMs: ${RULE}`,
  },
  'durability/contract.ts': { calls: 1, delays: 'a signature: a durable sleep, re-armed' },
  'durability/effect.ts': { calls: 1, delays: `reconcileTimeoutMs: ${RULE}` },
  'durability/scheduler.ts': { calls: 1, delays: 'stepped by scheduleAt' },
  'files/directory-appearance.ts': { calls: 2, delays: `settleMs: ${RULE}` },
  'files/file-io.ts': { calls: 1, delays: `inspectionTimeoutMs: ${RULE}` },
  'geo/resolver.ts': { calls: 1, delays: `reload intervalMs: ${RULE}` },
  'google/google.ts': { calls: 1, delays: `timeoutMs: ${RULE}` },
  'internal/channel.ts': { calls: 1, delays: `credit window wait timeoutMs: ${RULE}` },
  'internal/coalesced-task.ts': { calls: 1, delays: 'retry by BackoffPolicySchema' },
  'internal/deadline.ts': { calls: 3, delays: 'the rule itself and its callers' },
  'internal/process-identity.ts': { calls: 1, delays: 'constant; a test seam' },
  'internal/secure-fetch.ts': { calls: 3, delays: `timeoutMs, bodyTimeoutMs: ${RULE}` },
  'internal/timers.ts': {
    calls: 2,
    delays:
      'the abortable pause and the monotonic clock: steps of scheduleAt (the kernel, a managed schedule), a revision-signal wait of timeoutMs by schema with MAX_TIMER_MS, and the default sync session timer (deadlineMs: options refused by assertTimerMs where they are taken; retry by BackoffPolicySchema)',
  },
  'internal/with-exclusive-lock.ts': { calls: 1, delays: 'a capped retry pause' },
  'live/watch-client.ts': { calls: 1, delays: `holdMs: ${RULE}` },
  'observability/bounded-sink.ts': { calls: 1, delays: `drain timeoutMs: ${RULE}` },
  'observability/event-loop-delay.ts': {
    calls: 4,
    delays: `bucketMs: ${RULE}; the clock seam`,
  },
  'observability/log-repeat.ts': { calls: 1, delays: `windowMs: ${RULE}` },
  'process/group-settlement.ts': { calls: 2, delays: 'constant polls' },
  'process/group.ts': {
    calls: 4,
    delays: 'graceMs by schema; a capped poll; the deadline steps through scheduleAt',
  },
  'react/cache-bridge.ts': { calls: 1, delays: `freshWindow: ${RULE}` },
  'release/watcher.ts': { calls: 4, delays: `maxDeferMs: ${RULE}; the host seam` },
  'server/bun.ts': { calls: 2, delays: 'constant' },
  'server/contract-stream.ts': {
    calls: 1,
    delays: `stream lifetimeMs: ${RULE} at defineContract`,
  },
  'server/device-presence-handlers.ts': {
    calls: 1,
    delays: `commandTimeoutMs: ${RULE}; per-command timeoutMs by schema with MAX_TIMER_MS`,
  },
  'server/endpoint-dispatch.ts': {
    calls: 1,
    delays: 'inbound deadline budget capped by endpoint timeout and MAX_TIMER_MS',
  },
  'server/event-bus.ts': { calls: 2, delays: `listenerTimeoutMs: ${RULE} at defineEvents` },
  'server/shutdown.ts': {
    calls: 4,
    delays: 'ShutdownOptionsSchema with MAX_TIMER_MS; constant',
  },
  'server/streaming-pump.ts': { calls: 1, delays: 'a macrotask' },
  'server/streaming-route.ts': { calls: 1, delays: `heartbeatMs: ${RULE}` },
  'server/swept-map.ts': {
    calls: 1,
    delays: 'constant sweep of the cache and the rate limiter',
  },
  'server/unix-client-bun.ts': { calls: 1, delays: `headersTimeoutMs: ${RULE}` },
  'server/unix-client.ts': { calls: 1, delays: `headersTimeoutMs: ${RULE}` },
  'service-host/config-reloader-source.ts': { calls: 1, delays: `pollIntervalMs: ${RULE}` },
  'service-host/host-adapter.ts': {
    calls: 2,
    delays: 'the adapter seam; polls under a domain range',
  },
  'service-host/launchd-plist.ts': { calls: 1, delays: 'a signature' },
  'service-host/launchd.ts': { calls: 3, delays: 'a domain range of at most 300 000 ms' },
  'service-host/systemd-inspect.ts': { calls: 1, delays: 'a signature' },
  'service-host/systemd.ts': { calls: 2, delays: 'a domain range of at most 300 000 ms' },
  'service-host/work/launch.ts': {
    calls: 2,
    delays:
      'constant SCOPE_ENTRY_POLL_MS (10 ms) poll step inside the SCOPE_ENTRY_TIMEOUT_MS deadline',
  },
  'sync/server-store-check.ts': { calls: 1, delays: 'constant' },
  'telegram/screens/runtime.ts': { calls: 1, delays: `expiresInMs: ${RULE}` },
  'telegram/transport-connect.ts': {
    calls: 3,
    delays: `connectAttemptMs, connectBudgetMs: ${RULE}; constant`,
  },
  'telegram/transport.ts': { calls: 1, delays: `responseTimeoutMs: ${RULE}` },
  'telegram/update-intake.ts': { calls: 1, delays: `sweepEveryMs: ${RULE}` },
  'telegram/update-intake-work.ts': {
    calls: 3,
    delays: `leaseMs and a quarter of it: ${RULE}; a macrotask`,
  },
  'testing/managed-resource-conformance.ts': {
    calls: 1,
    delays: `watchdogTimeoutMs: ${RULE}`,
  },
  'testing/manual-clock.ts': { calls: 1, delays: 'a macrotask' },
  'testing/surface-conformance.ts': { calls: 1, delays: `probe timeoutMs: ${RULE}` },
  'tools/cli/run-stream.ts': {
    calls: 1,
    delays: `stream lifetimeMs: ${RULE} at defineContract`,
  },
  'tools/cli/stdin.ts': { calls: 1, delays: 'constant' },
  'tools/cli/update.ts': { calls: 1, delays: `timeoutMs: ${RULE}` },
  'tools/connections/catalog-cache.ts': { calls: 2, delays: 'constant' },
  'tools/durability-port.ts': { calls: 1, delays: 'a signature: a durable sleep, re-armed' },
  'tools/operations/wait-core.ts': {
    calls: 1,
    delays:
      'timeoutSec and defaultTimeout, in seconds: assertTimerSeconds before the first poll',
  },
  'tracking/delivery.ts': { calls: 1, delays: `retryDelayMs: ${RULE}` },
  'tracking/host.ts': { calls: 1, delays: `heartbeatMs: ${RULE}; constant` },
  'tracking/performance/collector.ts': {
    calls: 2,
    delays: `earlyDelayMs: ${RULE}; a macrotask`,
  },
};

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

test('every timer call in the source is accounted for by where its delay comes from', () => {
  for (const form of [
    'setTimeout(run, delayMs);',
    'window.setInterval(handler, ms);',
    'AbortSignal.timeout(timeoutMs);',
    'await sleep(delay, signal);',
    'await withDeadline(work, timeoutMs);',
    'await withDeadline<Answer>(work, timeoutMs);',
  ]) {
    expect(form.match(TIMER_CALL)?.length, form).toBe(1);
  }
  for (const form of [
    'clearTimeout(timer);',
    'withSignalDeadline(',
    'startIdleTimer(',
    'export async function withDeadline<VALUE = unknown>(',
    'export function sleep(ms: number, signal?: AbortSignal): Promise<void> {',
  ]) {
    expect(form.match(TIMER_CALL), form).toBeNull();
  }
  const root = join(import.meta.dir, '..', 'src');
  const found = Object.fromEntries(
    sourceFiles(root).flatMap((path) => {
      const calls = readFileSync(path, 'utf8').match(TIMER_CALL)?.length ?? 0;
      return calls > 0 ? [[path.slice(root.length + 1), calls]] : [];
    }),
  );
  expect(found).toEqual(
    Object.fromEntries(Object.entries(timerCalls).map(([path, { calls }]) => [path, calls])),
  );
});
