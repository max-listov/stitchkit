import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { packageDirectory, readReleaseTrain } from './release-train';

const root = join(import.meta.dir, '..');
const destination = join(root, 'release-artifacts');

async function run(command: string[], cwd: string = root): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`${command.join(' ')} failed`);
}

async function versionAt(directory: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(root, directory, 'package.json'), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null)
    throw new Error(`${directory} manifest is invalid`);
  const version = Reflect.get(manifest, 'version');
  if (typeof version !== 'string') throw new Error(`${directory} manifest has no version`);
  return version;
}

const train = await readReleaseTrain(root);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const release of train.releases) {
  const directory = packageDirectory(release.target);
  const version = await versionAt(directory);
  if (version !== release.version) {
    throw new Error(
      `release train selects ${release.target}@${release.version}, package is ${version}`,
    );
  }
  if (release.target === 'core') {
    for (const architecture of ['arm64', 'x64']) {
      if (
        !(await Bun.file(
          join(root, 'packages/core/native', `darwin-${architecture}.node`),
        ).exists())
      ) {
        throw new Error(`core release is missing validated Darwin ${architecture} binary`);
      }
    }
    await run(['bun', '--filter', 'stitchkit', 'build']);
  } else if (release.target === 'tui') {
    await run(['bun', '--filter', 'stitchkit', 'build']);
    await run(['bun', '--filter', 'stitchkit-tui', 'build']);
  } else {
    await run(['bun', '--filter', 'create-stitchkit', 'build']);
  }
  await run(['bun', 'pm', 'pack', '--destination', destination], join(root, directory));
}
