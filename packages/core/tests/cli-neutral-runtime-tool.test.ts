import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createCliInvoker,
  type RuntimeToolDefinitionWithOutput,
} from '../src/entrypoints/cli';

test('a neutral managed definition validates before handler side effects', async () => {
  const input = z.object({ text: z.string(), repeat: z.coerce.number().default(1) });
  const output = z.object({ size: z.number() });
  let calls = 0;
  const measure = {
    name: 'measure',
    description: 'Measure repeated text',
    identity: { serviceName: 'text', action: 'measure', method: 'POST' },
    transports: ['CLI'],
    input,
    output,
    handler: ({ input }) => {
      calls++;
      return { size: input.text.length * input.repeat };
    },
  } satisfies RuntimeToolDefinitionWithOutput<typeof input, typeof output>;
  const invoker = await createCliInvoker({ name: 'neutral', runtimeTools: [measure] });

  expect(await invoker.invoke('measure', { text: 'hello', repeat: '2' })).toEqual({
    ok: true,
    exitCode: 0,
    data: { size: 10 },
  });
  expect(calls).toBe(1);
  const refused = await invoker.invoke('measure', { text: 42 });
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe('VALIDATION_ERROR');
  expect(calls).toBe(1);
});
