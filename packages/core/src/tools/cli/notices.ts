import { AsyncLocalStorage } from 'node:async_hooks';
import { scanCliInvocation } from './args-scan';
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
    return;
  }
  const scan = scanCliInvocation(process.argv.slice(2));
  // Invalid framework flags are reported by `createCli` with exit code 2;
  // suppress the pre-invocation notice instead of emitting chatter on a refused line.
  if (scan.error !== undefined || scan.framework.quiet) return;
  process.stderr.write(text);
}
