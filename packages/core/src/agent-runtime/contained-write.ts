/**
 * Writing a contained file through its pinned parent: a new file created
 * exclusively, written fully, given its mode on the descriptor, then renamed
 * into place — never through a path an attacker can swap underneath.
 */
import { fchmod, write as writeDescriptor } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDarwinBinding, NumericFileHandle } from './contained-darwin';
import {
  type ContainedFileHandle,
  type ContainedParent,
  descriptorPath,
} from './contained-files';

async function writeDescriptorFully(descriptor: number, content: string): Promise<void> {
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await new Promise<number>((resolve, reject) => {
      writeDescriptor(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
        (error, bytesWritten) => (error ? reject(error) : resolve(bytesWritten)),
      );
    });
    if (written === 0) throw new Error('Contained file write made no progress');
    offset += written;
  }
}

async function chmodDescriptor(descriptor: number, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fchmod(descriptor, mode & 0o7777, (error) => (error ? reject(error) : resolve()));
  });
}

async function createDarwinFile(
  parent: ContainedFileHandle,
  name: string,
  content: string,
  mode: number,
): Promise<void> {
  const binding = loadDarwinBinding();
  const descriptor = binding.createFileAt(parent.fd, name, mode & 0o7777);
  let failed: unknown;
  try {
    await writeDescriptorFully(descriptor, content);
    await chmodDescriptor(descriptor, mode);
  } catch (error) {
    failed = error;
  } finally {
    try {
      await new NumericFileHandle(descriptor).close();
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed) {
    binding.unlinkAt(parent.fd, name);
    throw failed;
  }
}

/** Create or atomically replace one direct child through the pinned parent descriptor. */
export async function writeContainedFile(input: {
  parent: ContainedParent;
  content: string;
  replace: boolean;
  mode?: number;
}): Promise<void> {
  const mode = input.mode ?? 0o666;
  if (!input.replace) {
    if (process.platform === 'darwin') {
      await createDarwinFile(input.parent.handle, input.parent.basename, input.content, mode);
      return;
    }
    await writeFile(
      path.join(descriptorPath(input.parent.handle), input.parent.basename),
      input.content,
      { flag: 'wx', mode },
    );
    return;
  }

  const temporary = `.${input.parent.basename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (process.platform === 'darwin') {
    const binding = loadDarwinBinding();
    let created = false;
    try {
      await createDarwinFile(input.parent.handle, temporary, input.content, mode);
      created = true;
      binding.renameAt(input.parent.handle.fd, temporary, input.parent.basename);
    } catch (error) {
      if (created) binding.unlinkAt(input.parent.handle.fd, temporary);
      throw error;
    }
    return;
  }
  const directory = descriptorPath(input.parent.handle);
  const temporaryPath = path.join(directory, temporary);
  try {
    await writeFile(temporaryPath, input.content, { flag: 'wx', mode });
    await rename(temporaryPath, path.join(directory, input.parent.basename));
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
