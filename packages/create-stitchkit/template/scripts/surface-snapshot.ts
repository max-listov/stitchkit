#!/usr/bin/env bun
/**
 * Regenerate the committed surface snapshot — the anchor `surface-conformance`
 * compares the live contract surface against. Run it deliberately after an
 * intended surface change and review the diff like any other contract change.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSurface } from '../packages/backend/src/surface';
import { buildSurfaceManifest } from '../packages/backend/src/surface-manifest';
import { SURFACE_SNAPSHOT_PATH } from './surface-conformance';

const { services, socket } = await createSurface();
try {
  const manifest = buildSurfaceManifest(services);
  const target = join(process.cwd(), SURFACE_SNAPSHOT_PATH);
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.length} operation(s) to ${SURFACE_SNAPSHOT_PATH}`);
} finally {
  await socket.io.close();
}
