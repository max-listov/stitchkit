import { createHash } from 'node:crypto';

/**
 * The payload hash stored beside an accepted event, and compared when the same
 * `eventId` arrives again: an identical hash is a benign redelivery, a
 * different one is a conflict worth a warning.
 *
 * Deliberately `sha256(JSON.stringify(event))` over the **schema-parsed**
 * value, with no key sorting: that is exactly what consuming applications
 * already store, and zod fixes key order when it parses, so the hash is
 * stable. A canonicalised form would mismatch every stored hash for the seven
 * days an outbox can hold an event.
 */
export function hashTrackingEvent(event: unknown): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}
