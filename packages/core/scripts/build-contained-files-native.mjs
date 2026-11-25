import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { arch: { type: 'string' } } });
const arch = values.arch ?? process.arch;
if (arch !== 'arm64' && arch !== 'x64') throw new Error('Expected --arch arm64 or --arch x64');
const machine = arch === 'x64' ? 'x86_64' : 'arm64';

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

const layout = JSON.parse(readFileSync(path.join(root, 'native-layout.json'), 'utf8'));
const asset = layout.assets[arch];
if (typeof asset !== 'string') throw new Error('Unsupported native build architecture');
const output = path.resolve(root, asset);
if (!output.startsWith(`${root}/`))
  throw new Error('Native output must remain in its package');
const outputDirectory = path.dirname(output);
mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  process.env.CC ?? 'cc',
  [
    '-arch',
    machine,
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
execFileSync('lipo', ['-verify_arch', machine, output], { stdio: 'inherit' });
console.log(output);
