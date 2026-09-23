import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { EndpointMcpPolicy } from '../src/entrypoints/contract';
import { defineContract } from '../src/entrypoints/contract';
import { buildSurfaceManifest } from '../src/entrypoints/testing';
import { implement } from '../src/server/implement';

const Output = z.object({ value: z.string() });

/**
 * One operation, one declaration, one snapshot — so every case below differs
 * from the others only in the `mcp` policy it declares.
 */
function manifestFor(mcp?: EndpointMcpPolicy) {
  const contract = defineContract(
    { prefix: 'items', scope: 'user' },
    {
      generate: {
        method: 'POST',
        path: '/generate',
        desc: 'Generate',
        input: z.object({ prompt: z.string() }),
        output: Output,
        expose: ['HTTP', 'MCP'],
        ...(mcp === undefined ? {} : { tool: { mcp } }),
      },
    },
  );
  return buildSurfaceManifest({
    services: [implement(contract, { generate: () => ({ value: 'ok' }) })],
    mcpPreparation: { multiRound: { stateConfigured: true, maxRounds: 3 } },
  });
}

const ratioRounds = [
  { key: 'ratio', message: 'Which ratio?', schema: z.object({ ratio: z.string() }) },
];

const ratio: EndpointMcpPolicy = { inputRequired: ratioRounds };

describe('a declared round is part of the snapshot', () => {
  test('gaining inputRequired changes the snapshot', () => {
    expect(JSON.stringify(manifestFor(ratio))).not.toBe(JSON.stringify(manifestFor()));
  });

  test('changing the question changes the snapshot', () => {
    const asked: EndpointMcpPolicy = {
      inputRequired: [
        {
          key: 'ratio',
          message: 'Which aspect ratio?',
          schema: z.object({ ratio: z.string() }),
        },
      ],
    };
    expect(JSON.stringify(manifestFor(asked))).not.toBe(JSON.stringify(manifestFor(ratio)));
  });

  test("changing a round's schema changes the snapshot", () => {
    const widened: EndpointMcpPolicy = {
      inputRequired: [
        {
          key: 'ratio',
          message: 'Which ratio?',
          schema: z.object({ ratio: z.string(), seed: z.number() }),
        },
      ],
    };
    expect(JSON.stringify(manifestFor(widened))).not.toBe(JSON.stringify(manifestFor(ratio)));
  });

  test('a resolver is distinguishable from asking nothing and from a fixed list', () => {
    const dynamic: EndpointMcpPolicy = { inputRequired: () => ratioRounds };
    const [operation] = manifestFor(dynamic).operations;
    expect(operation?.mcp).toEqual({ inputRequired: 'resolved-per-call' });
    expect(manifestFor().operations[0]?.mcp).toBeNull();
    expect(manifestFor(ratio).operations[0]?.mcp).not.toEqual({
      inputRequired: 'resolved-per-call',
    });
  });

  test('the recorded round carries key, message and schema digest', () => {
    const [operation] = manifestFor(ratio).operations;
    const declared = operation?.mcp?.inputRequired;
    expect(Array.isArray(declared)).toBe(true);
    expect(declared).toHaveLength(1);
    const [first] = declared as Array<{ key: string; message: string; schema: string | null }>;
    expect(first?.key).toBe('ratio');
    expect(first?.message).toBe('Which ratio?');
    expect(typeof first?.schema).toBe('string');
  });
});
