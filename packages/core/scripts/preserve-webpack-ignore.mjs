/**
 * Bun strips Webpack's dynamic-import magic comment while emitting the browser
 * entry. Restore that single packaging directive in the generated artifact so
 * Webpack leaves Stitchkit's runtime-selected optional peer alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'dist', 'index.js');
const source = readFileSync(entry, 'utf8');
const needle = 'import(SOCKET_IO_CLIENT)';
const matches = source.split(needle).length - 1;
if (matches !== 1) {
  throw new Error(
    `[preserve-webpack-ignore] expected one optional Socket.IO import, found ${matches}`,
  );
}
writeFileSync(
  entry,
  source.replace(needle, 'import(/* webpackIgnore: true */ SOCKET_IO_CLIENT)'),
);
console.log('[preserve-webpack-ignore] optional Socket.IO import is Webpack-safe');
