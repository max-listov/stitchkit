import { expect, test } from 'bun:test';
import { createRealtimeClient, defineRealtimeContract } from '../src/entrypoints/realtime';

test('a synchronous peer loader failure is reported and a later connect retries it', async () => {
  const cause = new Error('injected loader failed synchronously');
  let attempts = 0;
  const reports: Array<{ message: string; data?: unknown; terminal: boolean }> = [];
  const client = createRealtimeClient(
    defineRealtimeContract({ serverToClient: {}, clientToServer: {} }),
    {
      url: 'http://127.0.0.1',
      peers: {
        client: () => {
          attempts++;
          throw cause;
        },
      },
      onConnectError: (error) => reports.push(error),
    },
  );
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(() => client.connect()).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(attempts).toBe(attempt);
      expect(reports).toHaveLength(attempt);
      expect(reports.at(-1)).toEqual({ message: cause.message, data: cause, terminal: true });
      expect(client.connected).toBe(false);
    }
  } finally {
    client.disconnect();
  }
});
