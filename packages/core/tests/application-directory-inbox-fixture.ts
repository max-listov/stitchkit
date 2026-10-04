import { afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectoryInbox } from '../src/application/directory-inbox';
import type { DirectoryInboxConfig } from '../src/application/directory-inbox-contract';

export const Entry = z.object({ text: z.string() }).strict();
export type Entry = z.infer<typeof Entry>;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
export async function inboxDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-intake-'));
  directories.push(path);
  return path;
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
export async function openInbox(
  directory: string,
  handle: DirectoryInboxConfig<Entry>['handle'],
  options: Partial<DirectoryInboxConfig<Entry>> = {},
) {
  const resource = createDirectoryInbox({
    id: 'intake',
    directory,
    schema: Entry,
    handle,
    ...options,
  });
  const { value: inbox } = await resource.start();
  return { resource, inbox };
}
export const identity = { source: 'updates', key: 'one' };
export function clock() {
  let value = Date.parse('2026-10-04T01:00:00.000Z');
  return {
    now: () => new Date(value),
    advance(ms: number) {
      value += ms;
    },
  };
}
