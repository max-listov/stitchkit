import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { InvocationPayloadSchema } from './invocation-schema';
import type { AgentRuntimeStore } from './store';

/** Serialize SDK payloads at the typed external boundary, retaining binary bytes privately. */
export function invocationJson(value: unknown) {
  // An error's cause chain may lead back to itself; each error is written once.
  const errors = new WeakSet<Error>();
  return z.json().parse(
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item instanceof Uint8Array)
          return { base64: Buffer.from(item).toString('base64') };
        if (item instanceof ArrayBuffer)
          return { base64: Buffer.from(item).toString('base64') };
        if (item instanceof Error) {
          if (errors.has(item)) return { name: item.name, message: item.message };
          errors.add(item);
          return { name: item.name, message: item.message, cause: item.cause };
        }
        return item;
      }),
    ),
  );
}
export function invocationHash(value: unknown): string {
  return createHash('sha256')
    .update(serializeCanonicalJson(invocationJson(value)))
    .digest('hex');
}

export function createInvocationPayloads(
  store: AgentRuntimeStore,
  key: Uint8Array,
  maxBytes: number,
) {
  if (key.byteLength !== 32)
    throw new TypeError('Invocation payload key must contain 32 bytes');
  const encryptionKey = Uint8Array.from(key);
  return {
    /** The largest serialized payload one artifact may hold. */
    maxBytes,
    async write(
      identity: {
        conversationId: string;
        invocationId: string;
        operationId: string;
        runId?: string;
      },
      value: unknown,
    ) {
      const data = Buffer.from(serializeCanonicalJson(invocationJson(value)));
      if (data.byteLength > maxBytes)
        throw new RangeError('Invocation payload exceeds maxPayloadBytes');
      const artifactId = randomUUID();
      const sha256 = createHash('sha256').update(data).digest('hex');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([identity.conversationId, identity.invocationId, artifactId]),
        ),
      );
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      const { conversationId } = identity;
      if (!store.appendEventOnce)
        throw new TypeError('Invocation payloads require atomic store.appendEventOnce');
      // Keyed by the artifact, so a read finds it by identity instead of by
      // scanning the conversation's log.
      await store.appendEventOnce(
        {
          conversationId,
          kind: 'provider/payload',
          payload: {
            ...identity,
            artifactId,
            sha256,
            bytes: data.byteLength,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          },
        },
        artifactId,
      );
      return { artifactId, sha256 };
    },
    decrypt(conversationId: string, value: unknown) {
      const payload = InvocationPayloadSchema.parse(value);
      if (
        payload.bytes > maxBytes ||
        payload.ciphertext.length > Math.ceil(maxBytes / 3) * 4
      ) {
        throw new RangeError('Invocation payload exceeds maxPayloadBytes');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(payload.iv, 'base64'),
      );
      decipher.setAAD(
        Buffer.from(
          JSON.stringify([conversationId, payload.invocationId, payload.artifactId]),
        ),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const data = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]);
      if (
        data.length !== payload.bytes ||
        createHash('sha256').update(data).digest('hex') !== payload.sha256
      ) {
        throw new Error('Invocation payload integrity mismatch');
      }
      return z.json().parse(JSON.parse(data.toString('utf8')));
    },
  };
}
