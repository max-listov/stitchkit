export function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodePayload(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function storageId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
