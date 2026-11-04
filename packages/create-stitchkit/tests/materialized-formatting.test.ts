import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runNativeCommand } from '../../core/src/entrypoints/process';
import {
  reapAfterEachTest,
  trackGroupLeader,
  trackPidFile,
} from '../../core/tests/support/process-reaper';

const created: string[] = [];
const template = resolve(import.meta.dir, '../template');
const biome = Bun.resolveSync('@biomejs/biome/bin/biome', template);

reapAfterEachTest();
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function command(args: string[], cwd?: string, env?: Record<string, string>) {
  const result = await runNativeCommand({
    executable: process.execPath,
    args,
    ...(cwd && { cwd }),
    ...(env && { env }),
    envPolicy: 'ambient',
    timeoutMs: 20_000,
    capture: true,
    maxOutputBytes: 1024 * 1024,
    onLeaderStarted: trackGroupLeader,
  });
  return {
    ...result,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

for (const example of [undefined, 'repository']) {
  test(`the no-install ${example ?? 'blank'} project passes its formatter after scope substitution`, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-formatted-project-'));
    created.push(parent);
    const destination = join(parent, 'generated-starter-with-a-long-name');
    const args = [resolve(import.meta.dir, '../src/cli.ts'), destination, '--no-install'];
    if (example) args.push('--example', example);
    const generated = await command(args);
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(existsSync(join(destination, 'node_modules'))).toBe(false);
    const checked = await command([biome, 'check', '.'], destination);
    expect(checked.exitCode, `${checked.stdout}\n${checked.stderr}`).toBe(0);
  }, 30_000);
}

async function formatterFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'stitchkit-format-failure-'));
  created.push(parent);
  const source = join(parent, 'template');
  const destination = join(parent, 'generated-app');
  await mkdir(source);
  await copyFile(join(template, 'project.json'), join(source, 'project.json'));
  await copyFile(join(template, 'biome.json'), join(source, 'biome.json'));
  await writeFile(join(source, 'package.json'), '{"name":"broken-template"}\n');
  const scaffold = JSON.stringify(resolve(import.meta.dir, '../src/scaffold.ts'));
  const expression = (formatter = 'undefined') =>
    `const { scaffoldProject } = await import(${scaffold}); await scaffoldProject(${JSON.stringify(source)}, ${JSON.stringify(destination)}, { formatter: ${formatter} });`;
  return { parent, source, destination, expression };
}

test('a formatter parse failure rolls back the scaffold instead of delivering a broken project', async () => {
  const { source, destination, expression } = await formatterFixture();
  await writeFile(join(source, 'broken.ts'), 'export const broken = ;\n');
  const result = await command(['--eval', expression()]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('broken.ts');
  expect(existsSync(destination)).toBe(false);
});

test('a formatter timeout kills the native child before rolling back the scaffold', async () => {
  const { parent, destination, expression } = await formatterFixture();
  const binary = join(parent, 'slow-biome');
  const pidFile = join(parent, 'formatter.pid');
  trackPidFile(pidFile);
  await writeFile(
    binary,
    '#!/usr/bin/env bun\nawait Bun.write(process.env.FORMATTER_PID_FILE, String(process.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
  );
  await chmod(binary, 0o755);
  const result = await command(
    ['--eval', expression(JSON.stringify({ binary, timeoutMs: 2_000 }))],
    undefined,
    { FORMATTER_PID_FILE: pidFile },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('ETIMEDOUT');
  expect(result.descendantsStopped).toBe(false);
  const childPid = Number(await readFile(pidFile, 'utf8'));
  expect(childPid).toBeGreaterThan(0);
  expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  expect(existsSync(destination)).toBe(false);
}, 30_000);
