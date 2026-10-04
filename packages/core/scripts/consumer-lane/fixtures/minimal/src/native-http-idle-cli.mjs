import { ApiError, createClient, createHttpClient } from 'stitchkit';
import { createCli, defineCliCommand } from 'stitchkit/cli';
import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';

const [lane, baseUrl, mode] = process.argv.slice(2);
if (!lane || !baseUrl || !mode) throw new Error('Missing idle fixture arguments');
const output = z.object({ ok: z.boolean() });
const report = z.object({
  ok: z.boolean(),
  elapsedMs: z.number(),
  errorName: z.string().optional(),
  code: z.string().optional(),
  sameReason: z.boolean().optional(),
  firstBodyBytes: z.number().optional(),
});
const timeout = mode.includes('deadline') ? 50 : 20_000;
const contract = defineContract(
  { prefix: '' },
  {
    mutate: {
      method: 'POST',
      path: `/${lane}/${mode}`,
      desc: 'Controlled native idle request',
      ...(mode === 'body-abort' ? { rawResponse: true } : { output }),
    },
  },
);

async function invoke() {
  const started = performance.now();
  const controller = new AbortController();
  let timer;
  try {
    if (mode === 'preabort')
      controller.abort(new DOMException('preabort control', 'AbortError'));
    if (mode === 'abort') {
      timer = setTimeout(
        () => controller.abort(new DOMException('caller control', 'AbortError')),
        50,
      );
    }
    if (lane === 'native') {
      await fetch(`${baseUrl}/${lane}/${mode}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeout),
      }).then((response) => response.json());
    } else {
      const client = createClient(
        contract,
        lane === 'configured'
          ? createHttpClient({ baseUrl, timeout, retry: { limit: 2 } })
          : { baseUrl, timeout },
      );
      const result = await client.mutate.withOptions({ signal: controller.signal });
      if (mode === 'body-abort') {
        if (!(result instanceof Response) || !result.body)
          throw new Error('Missing raw response body');
        const reader = result.body.getReader();
        const first = await reader.read();
        if (first.done || !first.value.byteLength) throw new Error('No initial body bytes');
        const reason = new DOMException('body caller control', 'AbortError');
        const pending = reader.read();
        void pending.catch(() => undefined);
        controller.abort(reason);
        try {
          await pending;
          throw new Error('Body read unexpectedly completed after caller abort');
        } catch (error) {
          return {
            ok: false,
            errorName: error?.name,
            sameReason: error === reason,
            firstBodyBytes: first.value.byteLength,
            elapsedMs: Math.round(performance.now() - started),
          };
        } finally {
          reader.releaseLock();
        }
      }
      if (!result.ok) throw new Error('Client received an invalid positive result');
    }
    return { ok: true, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (lane !== 'native' && !ApiError.is(error)) throw error;
    return {
      ok: false,
      errorName: error?.name,
      ...(ApiError.is(error) && { code: error.code }),
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

await createCli({
  name: 'idle-probe',
  version: '1',
  argv: ['check', '--json'],
  commands: [
    defineCliCommand({
      name: 'check',
      description: 'Measure native idle and framework deadline boundaries',
      input: z.object({}),
      output: report,
      handler: invoke,
    }),
  ],
});
