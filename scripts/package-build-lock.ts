import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface LockOwner {
  wrapperPid: number;
  childPid?: number;
}

const cwd = resolve(process.cwd());
// Bun consumes the conventional `--` separator before exposing script arguments.
const command = process.argv.slice(2);
if (command.length === 0) {
  throw new Error('Usage: package-build-lock.ts -- <command> [args...]');
}

const identity = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
const lock = join(tmpdir(), `stitchkit-package-build-${identity}`);
const ownerPath = join(lock, 'owner.json');
const deadline = Date.now() + 180_000;
const ownerEnvironmentKey = 'STITCHKIT_PACKAGE_BUILD_LOCK';

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const wrapperPid = Reflect.get(parsed, 'wrapperPid');
    const childPid = Reflect.get(parsed, 'childPid');
    if (typeof wrapperPid !== 'number') return undefined;
    return {
      wrapperPid,
      ...(typeof childPid === 'number' ? { childPid } : {}),
    };
  } catch {
    return undefined;
  }
}

async function acquire(): Promise<void> {
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(ownerPath, `${JSON.stringify({ wrapperPid: process.pid })}\n`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const owner = await readOwner();
    if (owner && !processIsAlive(owner.wrapperPid) && !processIsAlive(owner.childPid)) {
      await rm(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the package build lock${owner ? ` held by PID ${owner.childPid ?? owner.wrapperPid}` : ''}`,
      );
    }
    await Bun.sleep(100);
  }
}

async function runCommand(
  environment: Record<string, string | undefined>,
  trackOwner: boolean,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (trackOwner) {
    await writeFile(
      ownerPath,
      `${JSON.stringify({ wrapperPid: process.pid, childPid: child.pid })}\n`,
    );
  }
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (process.env[ownerEnvironmentKey] === identity) {
  await runCommand(process.env, false);
} else {
  await acquire();
  try {
    await runCommand({ ...process.env, [ownerEnvironmentKey]: identity }, true);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
