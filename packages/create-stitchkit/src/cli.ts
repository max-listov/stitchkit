#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'bun';
import { parseProjectDeclaration } from './identity';
import { helpText, parseOptions } from './options';
import { scaffoldProject } from './scaffold';

export async function run(args: string[]): Promise<number> {
  try {
    const options = parseOptions(args);
    if (options === 'help') {
      process.stdout.write(helpText());
      return 0;
    }

    const destination = resolve(options.destination);
    const templateDirectory = resolve(import.meta.dir, '../template');
    const overlayDirectory = options.example
      ? resolve(import.meta.dir, `../examples/${options.example}`)
      : undefined;
    await scaffoldProject(templateDirectory, destination, {
      ...(overlayDirectory && { overlayDirectory }),
      ...(options.displayName && { displayName: options.displayName }),
    });

    if (options.install) {
      const install = spawn(['bun', 'install'], {
        cwd: destination,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const exitCode = await install.exited;
      if (exitCode !== 0) throw new Error(`bun install failed with exit code ${exitCode}`);
    }

    const mode = options.example ? ` with the ${options.example} example` : '';
    process.stdout.write(
      `\nCreated ${options.displayName ?? basename(destination)}${mode}\n\n`,
    );
    process.stdout.write(`  cd ${options.destination}\n`);
    process.stdout.write('  bun run dev\n\n');
    // Read back from the project that was just written, never restated here:
    // a port printed from memory is wrong the moment someone edits `.env`,
    // and it was the last copy of two numbers whose home is that file.
    for (const line of await roleAddresses(destination)) {
      process.stdout.write(`${line}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-stitchkit: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}

/**
 * Where each declared role will answer, read from the generated project.
 *
 * The roles and the variables that carry their ports come from `project.json`;
 * the values come from the `.env` the project creates from its own example. If
 * either is missing the scaffolder stays quiet rather than guessing — a wrong
 * address is worse than none.
 */
async function roleAddresses(destination: string): Promise<string[]> {
  try {
    const declaration = parseProjectDeclaration(
      JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')),
    );
    const environment = readEnvironmentExample(
      await readFile(join(destination, '.env.example'), 'utf8'),
    );
    const host = environment.BIND_HOST ?? '127.0.0.1';
    return declaration.roles.flatMap((role) => {
      const port = role.listener && environment[role.listener.portVariable];
      if (!role.listener || !port) return [];
      return [`${role.name}: http://${host}:${port}${role.listener.readinessPath}`];
    });
  } catch {
    return [];
  }
}

/** The `KEY=value` lines of an example environment. No dependency for five lines. */
function readEnvironmentExample(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1]) values[match[1]] = match[2] ?? '';
  }
  return values;
}
