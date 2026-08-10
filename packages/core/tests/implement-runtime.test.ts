import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';

const contract = defineContract(
  { prefix: 'health', scope: 'public' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read health',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

describe('implement runtime completeness', () => {
  test('fails at construction when a JavaScript caller omits a handler', () => {
    expect(() => Reflect.apply(implement, undefined, [contract, {}])).toThrow(
      '[stitchkit] implement: missing handler for "health.read"',
    );
  });
});
