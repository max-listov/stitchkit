/**
 * The executor contract's schemas refuse what they do not declare: a hello
 * carries capabilities and statuses, never a path, an environment or a token.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  defineAgentExecutorContract,
  ExecutorDeltaSchema,
  ExecutorDriverCapabilitiesSchema,
  type ExecutorHello,
  ExecutorHelloSchema,
  ExecutorStartupPhaseSchema,
  ExecutorStatusDeltaSchema,
  ExecutorThreadDispositionSchema,
  InteractionReplySchema,
  TurnReportSchema,
} from '../../src/entrypoints/agent-executor';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  createReplayExecutorDriver,
  replayDialectScenarios,
  runAgentEngineConformance,
  unpackReplayScenario,
} from '../../src/entrypoints/agent-executor/testing';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_ACP = resolve(import.meta.dir, '../fixtures/fake-acp-agent.ts');
const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');
const FAKE_CLAUDE = resolve(import.meta.dir, '../fixtures/fake-claude-engine.ts');

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

  test('a deny carries its message, and optional approve scope / deny interrupt parse and refuse invalid values', () => {
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'deny' },
      }).success,
    ).toBe(false);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'approve', scope: 'session' },
      }).success,
    ).toBe(true);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'approve', scope: 'forever' },
      }).success,
    ).toBe(false);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'approve', updatedInput: { answers: { q1: 'yes' } } },
      }).success,
    ).toBe(true);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'approve', updatedInput: 'not-an-object' },
      }).success,
    ).toBe(false);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'approve', updatedInput: ['array-not-object'] },
      }).success,
    ).toBe(false);
    expect(
      InteractionReplySchema.safeParse({
        turnId: 't',
        interactionId: 'i',
        reply: { kind: 'deny', message: 'stop', interrupt: true },
      }).success,
    ).toBe(true);
  });

  test('usage delta accepts optional cacheCreationInputTokens, thinkingTokens, total, and bounded modelUsage (<=64) and serializes to JSON Schema', () => {
    const valid = {
      type: 'usage' as const,
      turnId: 't1',
      itemId: 'usage',
      raw: { source: 'claude', type: 'result/success' },
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 7,
      thinkingTokens: 3,
      totalTokens: 30,
      costUsd: 0.01,
      total: {
        inputTokens: 100,
        outputTokens: 200,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 12,
        thinkingTokens: 8,
        totalTokens: 300,
      },
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 7,
          thinkingTokens: 3,
          webSearchRequests: 1,
          costUsd: 0.01,
          canonicalModel: 'claude-sonnet-4-6',
          provider: 'firstParty',
          costBasis: 'list' as const,
        },
      },
    };
    expect(ExecutorDeltaSchema.parse(valid)).toEqual(valid);
    const overCap: Record<string, { inputTokens: number; outputTokens: number }> = {};
    for (let i = 0; i < 65; i += 1)
      overCap[`model-${i}`] = { inputTokens: 1, outputTokens: 1 };
    expect(
      ExecutorDeltaSchema.safeParse({
        ...valid,
        modelUsage: overCap,
      }).success,
    ).toBe(false);
    expect(() => z.toJSONSchema(TurnReportSchema)).not.toThrow();
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

  test('driver capabilities, threadDisposition and startupPhase validate strictly and stay additive', () => {
    const cli = createClaudeCliDriver();
    const cliWithFiles = createClaudeCliDriver({ resolveFile: async () => new Uint8Array() });
    const sdk = createClaudeSdkDriver({
      query: () => {
        throw new Error('unused');
      },
      sdkVersion: '0.3.330',
    });
    const sdkFull = createClaudeSdkDriver({
      query: () => {
        throw new Error('unused');
      },
      sdkVersion: '0.3.330',
      forkSession: async () => ({ sessionId: 'forked' }),
      resolveFile: async () => new Uint8Array(),
    });
    const codex = createCodexDriver();
    const acp = createAcpDriver({ executable: 'agy', args: ['acp'] });

    for (const driver of [cli, cliWithFiles, sdk, sdkFull, codex, acp]) {
      expect(ExecutorDriverCapabilitiesSchema.parse(driver.capabilities)).toEqual(
        driver.capabilities,
      );
    }
    expect(cli.capabilities.runtimePolicyEnforcement).toBe('native');
    expect(cli.capabilities.images).toBe(false);
    expect(cliWithFiles.capabilities.images).toBe(true);
    expect(sdk.capabilities.runtimePolicyEnforcement).toBe('native');
    expect(sdk.capabilities.fork).toBe(false);
    expect(sdk.capabilities.images).toBe(false);
    expect(sdkFull.capabilities.fork).toBe(true);
    expect(sdkFull.capabilities.images).toBe(true);
    expect(codex.capabilities.runtimePolicyEnforcement).toBe('native');
    expect(codex.capabilities.steer).toBe(true);
    expect(codex.capabilities.fork).toBe(true);
    expect(codex.capabilities.compact).toBe(true);
    expect(acp.capabilities.runtimePolicyEnforcement).toBe('client-boundary');
    expect(acp.approvalEnforcement).toBe('agent-initiated');

    // Negative controls: extra keys, wrong types, unknown threadDisposition, invalid startupPhase.
    expect(
      ExecutorDriverCapabilitiesSchema.safeParse({ ...cli.capabilities, gitCheckpoints: true })
        .success,
    ).toBe(false);
    expect(
      ExecutorDriverCapabilitiesSchema.safeParse({
        ...cli.capabilities,
        runtimePolicyEnforcement: 'best-effort',
      }).success,
    ).toBe(false);
    expect(ExecutorThreadDispositionSchema.safeParse('reusable').success).toBe(true);
    expect(ExecutorThreadDispositionSchema.safeParse('broken').success).toBe(true);
    expect(ExecutorThreadDispositionSchema.safeParse('corrupted').success).toBe(false);

    expect(ExecutorStartupPhaseSchema.parse('  initializing  ')).toBe('initializing');
    expect(ExecutorStartupPhaseSchema.safeParse('').success).toBe(false);
    expect(ExecutorStartupPhaseSchema.safeParse('   \t\n ').success).toBe(false);
    expect(ExecutorStartupPhaseSchema.safeParse('x'.repeat(65)).success).toBe(false);

    const statusDelta = ExecutorStatusDeltaSchema.parse({
      type: 'status',
      turnId: 't1',
      itemId: 'status-1',
      raw: { source: 'acp', type: 'startup' },
      phase: 'spawning',
    });
    expect(ExecutorDeltaSchema.parse(statusDelta)).toEqual(statusDelta);

    const reportWithDisposition = TurnReportSchema.parse({
      turnId: 't1',
      threadId: 'th1',
      turnOrdinal: 1,
      instance: 'inst-1',
      fence: 1,
      executorSeq: 1,
      phase: 'failed',
      deltas: [
        statusDelta,
        {
          type: 'turn-end',
          turnId: 't1',
          itemId: 'end',
          raw: { source: 'acp', type: 'session/prompt' },
          outcome: 'failed',
          threadDisposition: 'broken',
        },
      ],
      failure: {
        kind: 'protocol',
        message: 'Invalid thinking signature',
        threadDisposition: 'broken',
      },
    });
    expect(reportWithDisposition.failure?.threadDisposition).toBe('broken');
    expect(() => z.toJSONSchema(TurnReportSchema)).not.toThrow();
    expect(() => z.toJSONSchema(ExecutorHelloSchema)).not.toThrow();

    // Backward compatibility: hello engine info without capabilities still parses cleanly.
    expect(ExecutorHelloSchema.parse(hello).engines[0]?.capabilities).toBeUndefined();
    expect(
      ExecutorHelloSchema.parse({
        ...hello,
        engines: [{ ...hello.engines[0], capabilities: cli.capabilities }],
      }).engines[0]?.capabilities,
    ).toEqual(cli.capabilities);
  });

  test('onStartupPhase observes spawning and verifying phases and isolates throwing callbacks', async () => {
    const phases: string[] = [];
    const makeFakeQuery = () => ({
      async *[Symbol.asyncIterator]() {
        // idle until closed
      },
      async interrupt() {
        return undefined;
      },
      close() {
        return undefined;
      },
      async initializationResult() {
        return {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: [],
          models: [],
          account: {},
          hooks_applied: true,
        };
      },
    });
    const sdk = createClaudeSdkDriver({
      query: makeFakeQuery,
      sdkVersion: '0.3.330',
      verifyDelegation: { requireHooksApplied: true },
    });
    const info = await sdk.info();
    expect(info.capabilities).toEqual(sdk.capabilities);

    const session = await sdk.open({
      profile: { profileId: 'p1', engine: 'claude-sdk', home: '/tmp' },
      cwd: '/tmp',
      onStartupPhase: (phase) => {
        phases.push(phase);
      },
    });
    await session.close();
    expect(phases).toEqual(['spawning', 'verifying']);

    // Throwing observer must not break session open.
    const resilient = await sdk.open({
      profile: { profileId: 'p1', engine: 'claude-sdk', home: '/tmp' },
      cwd: '/tmp',
      onStartupPhase: () => {
        throw new Error('observer boom');
      },
    });
    await resilient.close();
  });

  test('info().capabilities, resolveFile images flag, and onStartupPhase are honored across claude-cli, codex, and acp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-caps-phases-'));
    try {
      // Codex: capabilities.images reflects resolveFile; info(), open(), and connectControl() emit phases.
      const codexNoImg = createCodexDriver();
      const codexWithImg = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_SHARED_CODEX],
        ambient: { PATH: process.env.PATH, HOME: root },
        resolveFile: async () => new Uint8Array(),
        verifyThread: () => undefined,
      });
      expect(codexNoImg.capabilities.images).toBe(false);
      expect(codexWithImg.capabilities.images).toBe(true);
      expect((await codexWithImg.info()).capabilities).toEqual(codexWithImg.capabilities);

      const codexHome = join(root, 'codex-home');
      trackPidFile(join(codexHome, 'shared-pid.txt'));
      const codexOpenPhases: string[] = [];
      const codexSession = await codexWithImg.open({
        profile: { profileId: 'p-cx', engine: 'codex', home: codexHome },
        cwd: root,
        onStartupPhase: (phase) => codexOpenPhases.push(phase),
      });
      await codexSession.close();
      expect(codexOpenPhases).toEqual(['spawning', 'initializing', 'verifying']);

      const codexCtrlHome = join(root, 'codex-ctrl-home');
      trackPidFile(join(codexCtrlHome, 'shared-pid.txt'));
      const codexCtrlPhases: string[] = [];
      const codexCtrl = await codexWithImg.connectControl({
        profile: { profileId: 'p-cx-ctrl', engine: 'codex', home: codexCtrlHome },
        cwd: root,
        onStartupPhase: (phase) => codexCtrlPhases.push(phase),
      });
      await codexCtrl.close();
      expect(codexCtrlPhases).toEqual(['spawning', 'initializing']);

      // ACP: info().capabilities matches driver.capabilities; open() emits spawning + initializing.
      const acpHome = join(root, 'acp-home');
      const acpPid = join(root, 'acp.pid');
      trackPidFile(acpPid);
      const acp = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        ambient: { PATH: process.env.PATH, HOME: root },
        probeMode: 'passive',
        passiveVersion: '1.2.3',
      });
      expect((await acp.info()).capabilities).toEqual(acp.capabilities);
      const acpPhases: string[] = [];
      const acpSession = await acp.open({
        profile: {
          profileId: 'p-acp',
          engine: 'acp',
          home: acpHome,
          env: { FAKE_ACP_HOME: acpHome, FAKE_ENGINE_PID_FILE: acpPid },
        },
        cwd: root,
        onStartupPhase: (phase) => acpPhases.push(phase),
      });
      await acpSession.close();
      expect(acpPhases).toEqual(['spawning', 'initializing']);

      // Claude CLI: info().capabilities matches driver.capabilities; open() emits spawning.
      const cliHome = join(root, 'cli-home');
      const cliPid = join(root, 'cli.pid');
      trackPidFile(cliPid);
      const cli = createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        ambient: { PATH: process.env.PATH, HOME: root },
      });
      expect((await cli.info()).capabilities).toEqual(cli.capabilities);
      const cliPhases: string[] = [];
      const cliSession = await cli.open({
        profile: {
          profileId: 'p-cli',
          engine: 'claude-cli',
          home: cliHome,
          env: { FAKE_ENGINE_PID_FILE: cliPid },
        },
        cwd: root,
        onStartupPhase: (phase) => cliPhases.push(phase),
      });
      await cliSession.close();
      expect(cliPhases).toEqual(['spawning']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('negative controls: runAgentEngineConformance fails on invalid capabilities, missing findInput, or mismatched ACP policy', async () => {
    const runWithMutatedDriver = (
      mutate: (
        driver: ReturnType<typeof createReplayExecutorDriver>,
      ) => ReturnType<typeof createReplayExecutorDriver>,
      engine: 'acp' | 'codex' = 'acp',
      reconcile: 'none' | 'client-id' = 'none',
    ) =>
      runAgentEngineConformance({
        scenarios: replayDialectScenarios(),
        async open(scenario) {
          const base = createReplayExecutorDriver({
            engine,
            reconcile,
            turns: [unpackReplayScenario(scenario)],
          });
          const driver = mutate(base);
          return {
            driver,
            profile: { profileId: 'neg-caps', engine, home: '/tmp' },
            cwd: '/tmp',
            inputs: async (threadId) => base.inputsFor(threadId),
            answered: async (req) => base.wasAnswered(req.interactionId),
            cleanup: async () => undefined,
          };
        },
      });

    // 1) Invalid capabilities shape fails conformance.
    await expect(
      runWithMutatedDriver((base) => ({
        ...base,
        capabilities: { ...base.capabilities, planLimits: 'bogus' as 'none' },
      })),
    ).rejects.toThrow();

    // 2) reconcile: 'client-id' without findInput fails conformance.
    await expect(
      runWithMutatedDriver(
        (base) => {
          const withoutFind = { ...base };
          delete (withoutFind as { findInput?: unknown }).findInput;
          return withoutFind;
        },
        'codex',
        'client-id',
      ),
    ).rejects.toThrow();

    // 3) ACP declaring runtimePolicyEnforcement: 'native' fails conformance.
    await expect(
      runWithMutatedDriver(
        (base) => ({
          ...base,
          capabilities: { ...base.capabilities, runtimePolicyEnforcement: 'native' },
        }),
        'acp',
        'none',
      ),
    ).rejects.toThrow();
  });
});
