// A holder that never acquires the lock, or an assertion that fails after it did, leaves no child behind.
import assert from 'node:assert/strict';

const [helper, files] = process.argv.slice(2);
const { verifySharedUID } = await import(helper);
for (const readiness of [false, true]) {
  let pid;
  const refusal = new Error('assertion control');
  await assert.rejects(
    verifySharedUID(files, {
      ...(readiness ? { holderCode: 'setInterval(()=>{},20)' } : {}),
      onHolder(value) {
        pid = value;
      },
      afterHeld() {
        throw refusal;
      },
    }),
    readiness ? /Holder did not acquire/ : (error) => error === refusal,
  );
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}
console.log('UID owned holder controls: ok');
