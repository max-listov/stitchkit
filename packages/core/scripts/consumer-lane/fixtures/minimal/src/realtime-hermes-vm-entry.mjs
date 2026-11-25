/** Real Hermes V1 VM entry: bind `stitchkit/realtime` to an existing socket and print a marker. */
import { bindSharedSocket, expectedBinding } from './realtime-hermes-client.mjs';

bindSharedSocket()
  .then((result) => {
    const actual = JSON.stringify(result);
    if (actual !== expectedBinding) throw new Error(`Unexpected binding outcome: ${actual}`);
    if (!globalThis.realtimeSurface.includes('bindRealtimeClient'))
      throw new Error('stitchkit/realtime surface lacks bindRealtimeClient');
    print('HERMES_VM_REALTIME_BIND_OK');
  })
  .catch((error) => {
    // Re-throw inside a macrotask so the Hermes CLI exits non-zero with the failure.
    setTimeout(() => {
      throw error;
    }, 0);
  });
