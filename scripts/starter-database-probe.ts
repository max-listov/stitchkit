import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createStarterAdminSql } from './starter-database';

export const STARTER_DATABASE_PROBE_QUERY = `SELECT json_build_object(
  'version', current_setting('server_version'), 'database', current_database(),
  'user', current_user, 'address', coalesce(inet_server_addr()::text, 'local-socket'),
  'port', coalesce(inet_server_port(), 0))::text AS proof`;

const DatabaseProofSchema = z.object({
  version: z.string().regex(/^\d/),
  database: z.string(),
  user: z.string(),
  address: z.string(),
  port: z.number().int().nonnegative(),
});

/** Reduces a SELECT-only proof before it can leave the measurement process. */
export function databaseProbeFingerprint(source: string): string {
  const proof = DatabaseProofSchema.parse(JSON.parse(source));
  const version = proof.version.split(' ')[0];
  return `pg:${version}:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`;
}

if (import.meta.main) {
  const url = Bun.env.STARTER_TEST_DATABASE_ADMIN_URL;
  if (!url) process.exit(1);
  let sql: ReturnType<typeof createStarterAdminSql> | undefined;
  try {
    sql = createStarterAdminSql(url);
    const rows: unknown = await sql.unsafe(STARTER_DATABASE_PROBE_QUERY);
    const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
    const proof =
      typeof row === 'object' && row !== null ? Reflect.get(row, 'proof') : undefined;
    if (typeof proof !== 'string') throw new Error('Unknown database proof');
    const fingerprint = databaseProbeFingerprint(proof);
    await sql.close({ timeout: 0.25 });
    process.stdout.write(fingerprint);
  } catch {
    await sql?.close({ timeout: 0.25 }).catch(() => undefined);
    process.exitCode = 1;
  }
}
