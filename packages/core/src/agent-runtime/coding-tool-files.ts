import { createHash } from 'node:crypto';
import { type FileHandle, lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineRuntimeTool } from '../tools/runtime-tool';
import {
  type AgentCodingToolConfig,
  type AgentCodingToolDefinition,
  type AgentCodingToolLimits,
  FileReadInputSchema,
  FileReadOutputSchema,
  FileWriteInputSchema,
  FileWriteOutputSchema,
} from './coding-tool-contract';
import {
  atomicCodingReplace,
  authorizeCodingTool,
  boundedCodingRelativePath,
} from './coding-tool-paths';
import {
  assertContainedFileCurrent,
  assertContainedParentCurrent,
  openContainedFile,
  openContainedParent,
} from './contained-files';

async function digestFile(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
  for (let position = 0; position < size; ) {
    const length = Math.min(chunk.byteLength, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

export function createFileCodingTools(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): readonly AgentCodingToolDefinition[] {
  const read = defineRuntimeTool({
    name: 'read_file',
    description: 'Read a bounded UTF-8 slice from a host-authorized workspace file.',
    identity: { serviceName: 'coding', action: 'read-file', method: 'POST' },
    input: FileReadInputSchema,
    output: FileReadOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const relative = boundedCodingRelativePath(input.path, limits.maxPathBytes);
      const handle = await openContainedFile(root, relative);
      const maximum = Math.min(input.maxBytes ?? limits.maxReadBytes, limits.maxReadBytes);
      let selected: Buffer;
      let size: number;
      let sha256: string;
      try {
        await authorizeCodingTool(config, { operation: 'read', path: relative });
        await assertContainedFileCurrent(root, relative, handle);
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new Error('Coding read path is not a regular file');
        size = metadata.size;
        const length = Math.min(maximum, Math.max(0, size - input.offset));
        selected = Buffer.alloc(length);
        const { bytesRead } = await handle.read(selected, 0, length, input.offset);
        selected = selected.subarray(0, bytesRead);
        sha256 = await digestFile(handle, size);
      } finally {
        await handle.close();
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(selected);
      const end = input.offset + selected.byteLength;
      const truncated = end < size;
      return {
        path: relative,
        text,
        bytes: selected.byteLength,
        sha256,
        truncated,
        ...(truncated && { nextOffset: end }),
      };
    },
  });

  const write = defineRuntimeTool({
    name: 'write_file',
    description: 'Write bounded UTF-8 content to a host-authorized workspace file.',
    identity: { serviceName: 'coding', action: 'write-file', method: 'POST' },
    input: FileWriteInputSchema,
    output: FileWriteOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) => {
      const root = await realpath(config.root);
      const relative = boundedCodingRelativePath(input.path, limits.maxPathBytes);
      const bytes = Buffer.byteLength(input.content);
      if (bytes > limits.maxWriteBytes)
        throw new Error('Coding tool write exceeds maxWriteBytes');
      const parent = await openContainedParent(root, relative);
      const target = path.join(parent.path, parent.basename);
      try {
        await authorizeCodingTool(config, {
          operation: 'write',
          path: relative,
          bytes,
          overwrite: input.overwrite,
        });
        await assertContainedParentCurrent(root, relative, parent.handle);
        if (input.overwrite) {
          const current = await lstat(target).catch(() => null);
          if (current?.isSymbolicLink())
            throw new Error('Coding tools do not overwrite symlinks');
          await atomicCodingReplace(target, input.content, current?.mode);
        } else {
          await writeFile(target, input.content, { flag: 'wx' });
        }
      } finally {
        await parent.handle.close();
      }
      return { path: relative, bytes };
    },
  });

  return [read, write];
}
