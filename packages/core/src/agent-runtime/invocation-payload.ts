import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { InvocationPayloadSchema } from './schemas-invocation-payload';
import type { AgentRuntimeStore } from './store';

export type InvocationJsonValue = z.infer<ReturnType<typeof z.json>>;

function walkInvocationJson(
  value: unknown,
  ancestors: WeakSet<object>,
  errors: WeakSet<Error>,
): InvocationJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;

  if (value instanceof Uint8Array) {
    return { base64: Buffer.from(value).toString('base64') };
  }
  if (value instanceof ArrayBuffer) {
    return { base64: Buffer.from(value).toString('base64') };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (value instanceof Error) {
    if (errors.has(value)) return { name: value.name, message: value.message };
    errors.add(value);
    const out: Record<string, InvocationJsonValue> = {
      name: value.name,
      message: value.message,
    };
    if (value.cause !== undefined) {
      out.cause = walkInvocationJson(value.cause, ancestors, errors);
    }
    return out;
  }
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walkInvocationJson(item, ancestors, errors));
    }
    const toJson = Reflect.get(value, 'toJSON');
    if (typeof toJson === 'function') {
      const converted: unknown = Reflect.apply(toJson, value, []);
      if (converted !== value) {
        return walkInvocationJson(converted, ancestors, errors);
      }
    }
    const out: Record<string, InvocationJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
        continue;
      }
      out[key] = walkInvocationJson(entry, ancestors, errors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Serialize SDK payloads at the typed external boundary, retaining binary bytes privately. */
export function invocationJson(value: unknown): InvocationJsonValue {
  return walkInvocationJson(value, new WeakSet<object>(), new WeakSet<Error>());
}

export function invocationHash(value: unknown): string {
  return createHash('sha256')
    .update(serializeCanonicalJson(invocationJson(value)))
    .digest('hex');
}

/**
 * Raised when a serialized invocation payload exceeds `maxPayloadBytes`.
 * Carries the measured byte length, configured ceiling, and SHA-256 of the
 * canonical serialized payload so callers can record omission evidence without
 * re-serializing or re-hashing.
 */
export class InvocationPayloadTooLargeError extends RangeError {
  readonly bytes: number;
  readonly maxBytes: number;
  readonly sha256: string;

  constructor(bytes: number, maxBytes: number, sha256: string) {
    super(`Invocation payload (${bytes} bytes) exceeds maxPayloadBytes (${maxBytes})`);
    this.name = 'InvocationPayloadTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
    this.sha256 = sha256;
  }
}

export interface InvocationPayloadIdentity {
  conversationId: string;
  invocationId: string;
  operationId: string;
  runId?: string;
}

export function createInvocationPayloads(
  store: AgentRuntimeStore,
  key: Uint8Array,
  maxBytes: number,
) {
  if (key.byteLength !== 32)
    throw new TypeError('Invocation payload key must contain 32 bytes');
  const encryptionKey = Uint8Array.from(key);

  const writeSerialized = async (
    identity: InvocationPayloadIdentity,
    data: Uint8Array,
    sha256: string,
  ) => {
    if (data.byteLength > maxBytes) {
      throw new InvocationPayloadTooLargeError(data.byteLength, maxBytes, sha256);
    }
    const artifactId = randomUUID();
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
  };

  return {
    /** The largest serialized payload one artifact may hold. */
    maxBytes,
    writeSerialized,
    async write(identity: InvocationPayloadIdentity, value: unknown) {
      const data = Buffer.from(serializeCanonicalJson(invocationJson(value)));
      const sha256 = createHash('sha256').update(data).digest('hex');
      return writeSerialized(identity, data, sha256);
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
