import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
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
import { authorizeCodingTool, boundedCodingRelativePath } from './coding-tool-paths';
import { codingPathRefusal, refuseMissingCodingPath } from './coding-tool-refusals';
import {
  assertContainedFileCurrent,
  assertContainedParentCurrent,
  type ContainedFileHandle,
  containedEntryMetadata,
  missingContainedDirectories,
  openContainedFile,
  openContainedParent,
  writeContainedFile,
} from './contained-files';

async function digestFile(handle: ContainedFileHandle, size: number): Promise<string> {
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
      const handle = await openContainedFile(root, relative).catch((error: unknown) =>
        refuseMissingCodingPath(error, relative),
      );
      const maximum = Math.min(input.maxBytes ?? limits.maxReadBytes, limits.maxReadBytes);
      let selected: Buffer;
      let size: number;
      let sha256: string;
      try {
        await authorizeCodingTool(config, { operation: 'read', path: relative });
        await assertContainedFileCurrent(root, relative, handle);
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          codingPathRefusal('BAD_REQUEST', 'This path is not a regular file', relative, {
            hint: 'Use list_directory to see what is here.',
          });
        }
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
      if (bytes > limits.maxWriteBytes) {
        codingPathRefusal(
          'BAD_REQUEST',
          `The content is ${bytes} bytes, over the ${limits.maxWriteBytes}-byte limit`,
          relative,
          {
            details: { bytes, maxWriteBytes: limits.maxWriteBytes },
            hint: 'Write a smaller file, or split it.',
          },
        );
      }
      // Read what would be created BEFORE anything is created: the host cannot
      // authorize a mutation it has not been told about, and `openContainedParent`
      // used to run ahead of `authorize` entirely.
      const createsDirectories = await missingContainedDirectories(root, relative).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
            codingPathRefusal(
              'CONFLICT',
              'A segment of this path is not a directory',
              relative,
              {
                hint: 'Write under a different path, or remove the file blocking it.',
              },
            );
          }
          throw error;
        },
      );
      await authorizeCodingTool(config, {
        operation: 'write',
        path: relative,
        bytes,
        overwrite: input.overwrite,
        createsDirectories,
      });
      const parent = await openContainedParent(root, relative, { create: true }).catch(
        (error: unknown) => {
          // The one shape a caller can act on: a segment of the requested path is
          // occupied by something that is not a directory.
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code === 'ENOTDIR' ||
            (error instanceof Error && error.message.includes('ancestor is not a directory'))
          ) {
            codingPathRefusal(
              'CONFLICT',
              'A segment of this path is not a directory',
              relative,
              {
                details: { createsDirectories },
                hint: 'Write under a different path, or remove the file blocking it.',
              },
            );
          }
          throw error;
        },
      );
      try {
        await assertContainedParentCurrent(root, relative, parent.handle);
        const current = await containedEntryMetadata(parent);
        if (input.overwrite) {
          if (current?.isSymbolicLink()) {
            codingPathRefusal('FORBIDDEN', 'This path is a symlink', relative, {
              hint: 'Coding tools never write through symlinks; write to the target directly.',
            });
          }
          await writeContainedFile({
            parent,
            content: input.content,
            replace: true,
            ...(current && { mode: current.mode }),
          });
        } else {
          if (current) {
            codingPathRefusal('CONFLICT', 'This file already exists', relative, {
              hint: 'Pass overwrite: true to replace it, or edit_file to change part of it.',
            });
          }
          await writeContainedFile({ parent, content: input.content, replace: false });
        }
      } finally {
        await parent.handle.close();
      }
      return { path: relative, bytes, createdDirectories: createsDirectories };
    },
  });

  return [read, write];
}
