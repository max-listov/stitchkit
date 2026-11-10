/**
 * Listen on an ephemeral loopback port a Fetch client may call.
 *
 * WHATWG Fetch refuses a fixed list of destination ports before any request
 * leaves (`TypeError: fetch failed`, cause `bad port`), and an operating system
 * with a wide ephemeral range hands those ports to `listen(0)` like any other.
 * The list ends at 10080, so a port above it is always callable: a lower
 * allocation is closed and taken again. The product's `serveNode` makes the
 * same decision against the exact list (`src/internal/fetch-port.ts`); a
 * fixture serving raw `node:http` makes it here.
 * https://fetch.spec.whatwg.org/#port-blocking
 *
 * The consumer lane copies this file into every fixture package's `src/` when
 * it prepares the package, so each fixture imports it as `./listen-fetchable.mjs`.
 */

/** The last port on the Fetch block list. */
export const HIGHEST_FETCH_BLOCKED_PORT = 10080;

const ATTEMPTS = 32;

function listenOnce(server, host) {
  return new Promise((resolve, reject) => {
    const refuse = (error) => reject(error);
    server.once('error', refuse);
    server.listen(0, host, () => {
      server.off('error', refuse);
      resolve();
    });
  });
}

function closeOnce(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Bind `server` to a loopback port above the Fetch block list and return the port. */
export async function listenFetchable(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    await listenOnce(server, host);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    if (address.port > HIGHEST_FETCH_BLOCKED_PORT) return address.port;
    await closeOnce(server);
  }
  throw new Error(
    `no ephemeral port above ${HIGHEST_FETCH_BLOCKED_PORT} after ${ATTEMPTS} attempts — Fetch would refuse every one`,
  );
}
