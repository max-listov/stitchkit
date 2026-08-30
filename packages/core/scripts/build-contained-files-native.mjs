import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.error('The contained-files native backend is built only on Darwin');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const includeCandidates = [
  path.resolve(process.execPath, '../../include/node'),
  '/usr/local/include/node',
  '/opt/homebrew/include/node',
];
const include = includeCandidates.find((candidate) =>
  existsSync(path.join(candidate, 'node_api.h')),
);
if (!include)
  throw new Error('Unable to locate the Node-API headers for the active Node runtime');

const outputDirectory = path.join(root, 'native');
mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `darwin-${process.arch}.node`);
execFileSync(
  process.env.CC ?? 'cc',
  [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-I',
    include,
    path.join(root, 'native-src', 'contained_files_darwin.c'),
    '-o',
    output,
  ],
  { stdio: 'inherit' },
);
console.log(output);
