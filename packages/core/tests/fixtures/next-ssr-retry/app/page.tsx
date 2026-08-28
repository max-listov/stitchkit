import { createHttpClient } from 'stitchkit';
import { AgentSchemaClientCompileProof } from './agent-schema-client';
import { SocketClientCompileProof } from './socket-client';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const origin = process.env.RETRY_ORIGIN_URL;
  const memoOrigin = process.env.MEMO_ORIGIN_URL;
  const controlUrl = process.env.RETRY_CONTROL_URL;
  if (!origin) throw new Error('RETRY_ORIGIN_URL is required');
  if (!memoOrigin) throw new Error('MEMO_ORIGIN_URL is required');
  if (!controlUrl) throw new Error('RETRY_CONTROL_URL is required');

  const nextFetch = globalThis.fetch;
  let recoveryFetchCalls = 0;
  const countingFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/recovery')) {
      recoveryFetchCalls += 1;
      const counted = await nextFetch(
        `${controlUrl}/count?kind=recovery&request=${input instanceof Request}&requestSignal=${input instanceof Request && input.signal instanceof AbortSignal}&explicit=${init?.signal !== undefined}`,
        { method: 'POST' },
      );
      if (!counted.ok) throw new Error('Could not record the logical fetch attempt');
    }
    try {
      return await nextFetch(input, init);
    } catch (error) {
      if (url.endsWith('/recovery') && recoveryFetchCalls === 1) {
        const started = await nextFetch(`${controlUrl}/start`, { method: 'POST' });
        if (!started.ok) throw new Error('Could not start the recovery origin');
        const ready = await nextFetch(`${origin}/ready`, {
          signal: new AbortController().signal,
        });
        if (!ready.ok) throw new Error('Recovery origin did not become reachable');
      }
      throw error;
    }
  };

  const memoClient = createHttpClient({ baseUrl: memoOrigin, retry: { limit: 1 } });
  const [memoA, memoB] = await Promise.all([
    memoClient.get<{ value: number }>('/memo'),
    memoClient.get<{ value: number }>('/memo'),
  ]);

  globalThis.fetch = countingFetch;
  const recoveryRequest = (() => {
    try {
      const client = createHttpClient({ baseUrl: origin, retry: { limit: 1 } });
      return client.get<{ ok: boolean }>('/recovery');
    } finally {
      globalThis.fetch = nextFetch;
    }
  })();
  const recovery = await recoveryRequest;

  return (
    <main
      id='result'
      data-recovery={String(recovery.ok)}
      data-recovery-fetch-calls={String(recoveryFetchCalls)}
      data-memo-a={String(memoA.value)}
      data-memo-b={String(memoB.value)}
    >
      <SocketClientCompileProof />
      <AgentSchemaClientCompileProof />
    </main>
  );
}
