import { createHash } from 'node:crypto';

/** Non-secret connection identity for diagnostics; credentials are never stored here. */
export function connectionInstanceId(name: string, url: string, instanceKey?: string): string {
  return createHash('sha256')
    .update(`${name}\u0000${url}\u0000${instanceKey ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}
