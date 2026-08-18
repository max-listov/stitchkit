// Binds a unix socket and holds it until killed. The SIGKILL path of the
// unix-transport tests uses this to produce a genuinely stale socket file.
export {};

const path = process.env.STITCHKIT_TEST_UNIX_PATH;
if (!path) throw new Error('STITCHKIT_TEST_UNIX_PATH is required');

Bun.serve({
  unix: path,
  fetch: () => Response.json({ holder: true }),
});
console.log('holder-listening');
// Keep the process alive until SIGKILL.
await new Promise(() => undefined);
