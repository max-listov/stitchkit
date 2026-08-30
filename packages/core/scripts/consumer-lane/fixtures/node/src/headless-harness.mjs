import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createMemoryAgentRuntimeStore, defineAgentProtocol } from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import {
  createAgentHarnessFileResources,
  createHeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textStream = (text) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: text },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ],
  }),
});
const modelB = new MockLanguageModelV4({ doStream: [textStream('model-b')] });
const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-packed-harness-'));
try {
  const initialProof = 'packed direct tool';
  await writeFile(path.join(root, 'proof.txt'), initialProof);
  const skillRoot = path.join(root, 'skills');
  const instructionRoot = path.join(root, 'instructions');
  const resourceRoot = path.join(root, 'resources');
  await mkdir(path.join(skillRoot, 'inspect'), { recursive: true });
  await mkdir(instructionRoot, { recursive: true });
  await mkdir(resourceRoot, { recursive: true });
  await writeFile(path.join(instructionRoot, 'base.md'), 'Use exact direct tools.');
  await writeFile(path.join(resourceRoot, 'reference.md'), 'Packed reference body.');
  await writeFile(
    path.join(skillRoot, 'inspect', 'SKILL.md'),
    '---\nname: inspect\ndescription: Inspect one exact file.\n---\n\nUse a direct coding tool.',
  );
  const proofSha256 = createHash('sha256').update(initialProof).digest('hex');
  const modelA = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'search-1',
              toolName: 'search_files',
              input: JSON.stringify({ query: 'proof.txt', mode: 'path' }),
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
            {
              type: 'tool-call',
              toolCallId: 'skill-1',
              toolName: 'read_resource',
              input: JSON.stringify({ name: 'inspect' }),
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
            {
              type: 'tool-call',
              toolCallId: 'patch-1',
              toolName: 'apply_patch',
              input: JSON.stringify({
                path: 'proof.txt',
                baseSha256: proofSha256,
                oldText: 'direct',
                newText: 'approved',
                dryRun: false,
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
            {
              type: 'tool-call',
              toolCallId: 'shell-1',
              toolName: 'run_command',
              input: JSON.stringify({
                executable: 'printf',
                args: ['0123456789abcdef'],
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
            {
              type: 'tool-call',
              toolCallId: 'artifact-read-1',
              toolName: 'read_output',
              input: JSON.stringify({ reference: 'packed-output', maxBytes: 64 }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
            },
          ],
        }),
      },
      textStream('model-a'),
    ],
  });
  const profiles = [];
  const artifacts = new Map();
  const codingTools = createAgentCodingTools({
    root,
    authorize: () => true,
    executables: { printf: '/usr/bin/printf' },
    artifacts: {
      write: ({ data }) => {
        artifacts.set('packed-output', data);
        return { reference: 'packed-output' };
      },
      read: ({ reference, offset, maxBytes }) => {
        const data = artifacts.get(reference);
        if (!data) throw new Error('packed artifact is missing');
        return { data: data.subarray(offset, offset + maxBytes), totalBytes: data.byteLength };
      },
    },
    limits: { maxShellOutputBytes: 8, maxArtifactBytes: 128 },
  });
  const fileResources = createAgentHarnessFileResources({
    roots: [
      { id: 'instructions', path: instructionRoot, kind: 'instruction' },
      { id: 'skills', path: skillRoot, kind: 'skill' },
      { id: 'resources', path: resourceRoot, kind: 'resource' },
    ],
  });
  const harness = createHeadlessAgentHarness({
    protocol: defineAgentProtocol({
      context: z.object({ model: z.enum(['a', 'b']) }),
      inputMetadata: z.object({}),
      terminalAcceptance: 'require-output',
    }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: ({ context }) => ({
        descriptor: {
          provider: 'packed',
          modelId: context.model === 'a' ? 'model-a' : 'model-b',
          contextWindow: 8_000,
          capabilities: ['tools'],
        },
        model: context.model === 'a' ? modelA : modelB,
      }),
    },
    resources: fileResources,
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: 1_000,
      toolSchemas: { value: 100, provenance: 'measured' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    estimateResourceTokens: () => ({ value: 4, provenance: 'measured' }),
    tools: (context) =>
      mountAgent([], {
        runtimeTools: [...codingTools, ...fileResources.runtimeTools],
        lifecycle: context.toolFenceLifecycle,
      }),
    loop: {
      toolApproval: { apply_patch: 'user-approval' },
      toolApprovalSecret: 'packed-approval-secret',
    },
    onProfile: (event) => {
      profiles.push(event);
    },
  });
  const submit = (conversationId, model) =>
    harness.submit({
      conversationId,
      idempotencyKey: `input-${model}`,
      context: { model },
      parts: [{ type: 'text', text: 'run' }],
      metadata: {},
    }).result;
  const [requested, second] = await Promise.all([
    submit('packed-a', 'a'),
    submit('packed-b', 'b'),
  ]);
  assert.equal(requested.reason, 'provider_stop');
  const [pending] = await harness.pendingApprovals('packed-a');
  assert.ok(pending);
  const continuation = await harness.respondToApproval({
    conversationId: 'packed-a',
    approvalId: pending.approvalId,
    approved: true,
    context: { model: 'a' },
  });
  const first = await continuation.result;
  assert.equal(first.reason, 'success');
  assert.equal(second.reason, 'success');
  assert.deepEqual(profiles.map(({ model }) => model.modelId).sort(), [
    'model-a',
    'model-a',
    'model-b',
  ]);
  assert.equal(
    profiles.every(({ resources }) =>
      resources.some(({ provenance }) => provenance === 'skills:inspect/SKILL.md'),
    ),
    true,
  );
  const snapshot = await harness.snapshot('packed-a');
  const parts = snapshot.messages.flatMap((message) => message.parts);
  assert.equal(
    parts.some(
      (part) =>
        part.type === 'tool-result' &&
        part.toolName === 'search_files' &&
        part.outcome === 'success',
    ),
    true,
  );
  assert.equal(
    parts.some(
      (part) =>
        part.type === 'tool-result' &&
        part.toolName === 'read_resource' &&
        part.outcome === 'success',
    ),
    true,
  );
  assert.equal(
    parts.some(
      (part) =>
        part.type === 'tool-result' &&
        part.toolName === 'apply_patch' &&
        part.outcome === 'success',
    ),
    true,
  );
  assert.equal(
    parts.some(
      (part) =>
        part.type === 'tool-result' &&
        part.toolName === 'read_output' &&
        part.outcome === 'success' &&
        part.output.text.includes('0123456789abcdef'),
    ),
    true,
  );
  assert.equal(
    parts.some(
      (part) =>
        part.type === 'tool-result' &&
        part.toolName === 'run_command' &&
        part.outcome === 'success' &&
        part.output.artifact?.reference === 'packed-output',
    ),
    true,
  );
  assert.equal(await readFile(path.join(root, 'proof.txt'), 'utf8'), 'packed approved tool');
  assert.equal(snapshot.runs[0]?.state, 'completed');
  await harness.close();
  console.log('packed headless harness: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
