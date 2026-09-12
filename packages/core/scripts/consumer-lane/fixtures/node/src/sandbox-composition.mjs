import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createLocalStepDurability,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { createHeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import {
  createBubblewrapSandboxBackend,
  createSandboxCodingTools,
} from 'stitchkit/agent-runtime/sandbox';
import { defineRuntimeTool, defineToolRegistry, mountAgent } from 'stitchkit/tools';
import { z } from 'zod';

const probe = spawnSync('/usr/bin/bwrap', [
  '--unshare-all',
  '--ro-bind',
  '/usr',
  '/usr',
  '--ro-bind',
  '/lib',
  '/lib',
  '--ro-bind',
  '/lib64',
  '/lib64',
  '--',
  '/usr/bin/true',
]);
if (probe.status === 0) {
  const root = await mkdtemp(join(tmpdir(), 'packed-sandbox-composition-'));
  const backend = await createBubblewrapSandboxBackend({
    stateDirectory: root,
    onBrokerError: console.error,
  });
  const template = await backend.prewarm({ template: 'composed' });
  let handle = await backend.create({ template: template.templateKey, network: 'deny-all' });
  let harness;
  try {
    const store = createMemoryAgentRuntimeStore();
    let effects = 0;
    let namespace;
    const definitions = createSandboxCodingTools(handle, {
      authorize: () => true,
      executables: { shell: '/usr/bin/sh' },
    });
    const command = definitions.find((tool) => tool.name === 'run_command');
    assert.ok(command);
    const durable = defineRuntimeTool({
      ...command,
      output: z.json(),
      handler: async (context) => {
        assert.ok(context.step);
        return context.step('sandbox-effect', async () => {
          effects++;
          const result = await command.handler(context);
          namespace = result.stdout.trim();
          return z.json().parse(result);
        });
      },
    });
    const registry = defineToolRegistry({ defaults: definitions })
      .replace('run_command', durable)
      .disable('glob')
      .build();
    assert.ok(!registry.names.includes('glob'));
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'command',
                toolName: 'run_command',
                input: JSON.stringify({
                  executable: 'shell',
                  args: ['-c', 'printf once >> effect; readlink /proc/self/ns/net'],
                }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'done' },
              { type: 'text-delta', id: 'done', delta: 'complete' },
              { type: 'text-end', id: 'done' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        },
      ],
    });
    const presented = [];
    harness = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({ principalId: z.string() }),
        inputMetadata: z.object({}),
        terminalAcceptance: 'require-output',
      }),
      store,
      durability: true,
      blockingPresentation: 'parent',
      publish: (event) => {
        presented.push(event);
      },
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'sandbox-composition',
            contextWindow: 16000,
            capabilities: ['tools'],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => ({
        contextWindow,
        reservedOutput: 1000,
        toolSchemas: { value: 100, provenance: 'measured' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      }),
      tools: () => mountAgent([], { runtimeTools: registry.tools }),
      loop: {
        toolApproval: { run_command: 'user-approval' },
        toolApprovalSecret: 'packed-sandbox-fixture',
      },
      authorizeApprovalResponse: ({ responder }) =>
        responder.principalId === 'owner'
          ? { status: 'allowed' }
          : { status: 'rejected', reason: 'not the initiating principal' },
    });
    await harness.submit({
      conversationId: 'composed',
      idempotencyKey: 'start',
      context: { principalId: 'owner' },
      metadata: {},
      parts: [{ type: 'text', text: 'execute the command' }],
    }).result;
    const [approval] = await harness.pendingApprovals('composed');
    assert.ok(approval);
    assert.equal(effects, 0);
    assert.ok(!JSON.stringify(presented).includes('tool-approval-request'));
    await assert.rejects(
      harness.respondToApproval({
        conversationId: 'composed',
        approvalId: approval.approvalId,
        approved: true,
        context: { principalId: 'intruder' },
      }),
    );
    assert.equal(effects, 0);
    const continuation = await harness.respondToApproval({
      conversationId: 'composed',
      approvalId: approval.approvalId,
      approved: true,
      context: { principalId: 'owner' },
    });
    assert.equal((await continuation.result).reason, 'success');
    assert.equal(effects, 1);
    assert.notEqual(namespace, await readlink('/proc/self/ns/net'));
    assert.equal(await handle.session.readTextFile('effect'), 'once');
    const state = handle.captureState();
    await handle.stop();
    await harness.close();
    harness = undefined;
    handle = await backend.create({
      template: template.templateKey,
      state,
      network: 'deny-all',
    });
    const events = await store.readEvents({ conversationId: 'composed', limit: 1000 });
    const record = events.items.find((event) => event.kind === 'durability/step');
    assert.ok(record);
    const payload = z
      .object({ runId: z.string(), stepName: z.string() })
      .parse(record.payload);
    const replay = createLocalStepDurability({
      store,
      conversationId: 'composed',
      runId: payload.runId,
    });
    await replay.step(payload.stepName, () => {
      throw new Error('recorded command executed again');
    });
    const read = mountAgent([], {
      runtimeTools: createSandboxCodingTools(handle, { authorize: () => true }),
    }).read_file.execute;
    const result = await read(
      { path: 'effect' },
      { toolCallId: 'read-after-reconnect', messages: [], context: undefined },
    );
    assert.equal(result.text, 'once');
    assert.equal(effects, 1);
  } finally {
    await harness?.close();
    await handle.delete();
    await rm(root, { recursive: true, force: true });
  }
} else {
  // The adjacent sandbox-backend fixture verifies the named unsupported-runtime refusal.
  console.log('sandbox composition: namespace execution unavailable on this host');
}
console.log('packed sandbox composition: ok');
