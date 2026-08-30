import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, writeFile } from 'node:fs/promises';
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
  existingCodingPath,
  writableCodingPath,
} from './coding-tool-paths';

async function digestFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<string> {
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
      const target = await existingCodingPath(root, input.path, limits.maxPathBytes);
      await authorizeCodingTool(config, { operation: 'read', path: target.relative });
      const maximum = Math.min(input.maxBytes ?? limits.maxReadBytes, limits.maxReadBytes);
      const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let selected: Buffer;
      let size: number;
      let sha256: string;
      try {
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
        path: target.relative,
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
      const target = await writableCodingPath(root, input.path, limits.maxPathBytes);
      const bytes = Buffer.byteLength(input.content);
      if (bytes > limits.maxWriteBytes)
        throw new Error('Coding tool write exceeds maxWriteBytes');
      await authorizeCodingTool(config, {
        operation: 'write',
        path: target.relative,
        bytes,
        overwrite: input.overwrite,
      });
      if (input.overwrite) {
        const current = await stat(target.absolute).catch(() => null);
        await atomicCodingReplace(target.absolute, input.content, current?.mode);
      } else {
        await writeFile(target.absolute, input.content, { flag: 'wx' });
      }
      return { path: target.relative, bytes };
    },
  });

  return [read, write];
}
