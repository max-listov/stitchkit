import { createRealtimeClient, defineRealtimeContract } from 'stitchkit';
import { z } from 'zod';

const Value = z.object({ n: z.number() });
const Args = z.tuple([Value]);
const Empty = z.tuple([]);
const contract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: {
    ping: { args: Args, ack: Value },
    diagnosticLate: { args: Empty, ack: Value },
    diagnosticDrop: { args: Empty, ack: Value },
  },
});
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(client) {
  let off;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('connection timeout')), 2000);
      off = client.onConnectionChange((connected) => {
        if (connected) resolve();
      });
      client.connect();
    });
  } finally {
    clearTimeout(timeout);
    off?.();
  }
}

export async function runObservationProof(url, scope) {
  const phases = [];
  const observe = (phase) => {
    phases.push(phase);
  };
  const client = createRealtimeClient(contract, {
    url,
    transports: ['websocket'],
    reconnectOnServerDisconnect: false,
    peers: { client: () => import('socket.io-client') },
    onRequestPhase: scope === 'client' ? observe : undefined,
  });
  const options = { timeoutMs: 1000, onPhase: scope === 'request' ? observe : undefined };
  const refusal = async (promise, code) => {
    try {
      await promise;
      throw new Error(`expected ${code}`);
    } catch (error) {
      check(error.code === code, `expected ${code}, got ${error}`);
    }
  };
  try {
    await connect(client);
    if (scope === 'request') {
      check(
        (await client.request('ping', { n: 0 }, { timeoutMs: 1000 })).n === 1,
        'unobserved control',
      );
      check(phases.length === 0, 'unobserved request created phases');
    }
    const values = await Promise.all([
      client.request('ping', { n: 1 }, options),
      client.request('ping', { n: 2 }, options),
    ]);
    check(values[0].n === 2 && values[1].n === 3, 'concurrent acknowledgements');
    await refusal(
      client.request('diagnosticLate', { ...options, timeoutMs: 5 }),
      'REALTIME_REQUEST_TIMEOUT',
    );
    const count = phases.length;
    await wait(100);
    check(phases.length === count, 'late acknowledgement reopened a terminal trace');
    await refusal(client.request('diagnosticDrop', options), 'REALTIME_REQUEST_DISCONNECTED');
    await refusal(client.request('ping', { n: 3 }, options), 'REALTIME_REQUEST_DISCONNECTED');
    client.disconnect();
    await connect(client);
    check(
      (await client.request('ping', { n: 4 }, options)).n === 5,
      'request after reconnect',
    );
    const byId = new Map();
    for (const phase of phases) {
      check(
        typeof phase.requestId === 'string' && phase.requestId.length > 0,
        'opaque identity',
      );
      check(
        Object.keys(phase).sort().join(',') === 'elapsedMs,event,phase,requestId',
        'metadata-only observation',
      );
      const entries = byId.get(phase.requestId) ?? [];
      entries.push(phase.phase);
      byId.set(phase.requestId, entries);
    }
    check(byId.size === 6, 'each invocation must retain its own identity');
    for (const entries of byId.values()) {
      const terminal = entries.filter((phase) =>
        ['settled', 'timeout', 'disconnected'].includes(phase),
      );
      check(
        terminal.length === 1 && entries.at(-1) === terminal[0],
        'one terminal phase, last',
      );
    }
    return { scope, requests: byId.size, requestIds: [...byId.keys()], phases: phases.length };
  } finally {
    client.disconnect();
  }
}
