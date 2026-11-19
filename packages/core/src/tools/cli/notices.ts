import { AsyncLocalStorage } from 'node:async_hooks';
import { readCliBooleanFlag } from './args-route';
import type { CliIo } from './io';

const invocationNotices = new AsyncLocalStorage<{
  quiet: boolean;
  stderr: CliIo['stderr'];
}>();

export function withCliNotices<T>(quiet: boolean, stderr: CliIo['stderr'], run: () => T): T {
  return invocationNotices.run({ quiet, stderr }, run);
}

/** Profile selection can happen during discovery, before the CLI invocation starts. */
export function writeCliNotice(text: string): void {
  const invocation = invocationNotices.getStore();
  if (invocation !== undefined) {
    if (!invocation.quiet) invocation.stderr(text);
  } else if (!readCliBooleanFlag(process.argv.slice(2), 'quiet')) {
    process.stderr.write(text);
  }
}
