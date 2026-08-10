#!/usr/bin/env bun

import { basename, resolve } from 'node:path';
import { spawn } from 'bun';
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
    process.stdout.write('Web: http://localhost:3210\n');
    process.stdout.write('API: http://localhost:3211\n');
    process.stdout.write('MCP: http://localhost:3211/mcp\n');
    process.stdout.write('OpenAPI: http://localhost:3211/openapi.json\n');
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
