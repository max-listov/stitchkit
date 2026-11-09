import { openContainedFile } from './contained-files';
import type { ContainedFileHandle } from './contained-handle';

export async function readContainedUtf8Handle(
  handle: ContainedFileHandle,
  maxBytes: number,
  progress?: {
    check(): void;
    readBytes(bytes: number): void;
    wait<T>(operation: () => Promise<T>): Promise<T>;
  },
): Promise<{ text: string; bytes: number; mode: number }> {
  progress?.check();
  const metadata = progress ? await progress.wait(() => handle.stat()) : await handle.stat();
  progress?.check();
  if (!metadata.isFile()) throw new Error('Contained path is not a regular file');
  if (metadata.size > maxBytes) {
    const error = new Error('Contained file exceeds byte budget');
    Object.assign(error, { code: 'FILE_TOO_LARGE' });
    throw error;
  }
  const buffer = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < buffer.byteLength) {
    progress?.check();
    const read = () =>
      handle
        .read(buffer, offset, Math.min(16_384, buffer.byteLength - offset), offset)
        .then((result) => {
          progress?.readBytes(result.bytesRead);
          return result;
        });
    const { bytesRead } = progress ? await progress.wait(read) : await read();
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== metadata.size) throw new Error('Contained file changed while being read');
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
    bytes: offset,
    mode: metadata.mode,
  };
}

/** Open the final path without following any mutable ancestor or replacement symlink. */
export async function readContainedUtf8File(
  root: string | ContainedFileHandle,
  relative: string,
  maxBytes: number,
): Promise<{ text: string; bytes: number; mode: number }> {
  const handle = await openContainedFile(root, relative);
  try {
    return await readContainedUtf8Handle(handle, maxBytes);
  } finally {
    await handle.close();
  }
}
