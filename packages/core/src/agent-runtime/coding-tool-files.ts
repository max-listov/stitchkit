import { createHash } from 'node:crypto';
import {
  assertContainedFileCurrent,
  assertContainedParentCurrent,
  containedEntryMetadata,
  missingContainedDirectories,
  openContainedFile,
  openContainedParent,
  UnapprovedContainedDirectoryError,
} from '../internal/contained-files';
import type { ContainedFileHandle } from '../internal/contained-handle';
import { writeContainedFile } from '../internal/contained-write';
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
  authorizeCodingPathChain,
  authorizeCodingTool,
  boundedCodingRelativePath,
  withCodingPathLock,
  withCodingRoot,
} from './coding-tool-paths';
import {
  codingPathRefusal,
  refuseMissingCodingPath,
  refuseWriteConflict,
} from './coding-tool-refusals';
import { utf8AlignedEnd, utf8AlignedStart } from './coding-tool-utf8';

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

/** Open the authorized creation plan and translate only the write conflicts a caller can act on. */
async function openAuthorizedWriteParent(
  root: ContainedFileHandle,
  relative: string,
  createsDirectories: readonly string[],
) {
  return openContainedParent(root, relative, { createDirectories: createsDirectories }).catch(
    (error: unknown) => {
      if (error instanceof UnapprovedContainedDirectoryError) {
        codingPathRefusal(
          'CONFLICT',
          'The directory creation plan changed during authorization',
          relative,
          {
            details: { createsDirectories },
            hint: 'Retry the write so the host can authorize the current directories.',
          },
        );
      }
      refuseWriteConflict(error, relative, { createsDirectories });
    },
  );
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
    handler: async ({ input }) =>
      withCodingRoot(config.root, async (root, rootPath) => {
        const relative = boundedCodingRelativePath(rootPath, input.path, limits.maxPathBytes);
        await authorizeCodingPathChain(config, relative, root);
        const handle = await openContainedFile(root, relative).catch((error: unknown) =>
          refuseMissingCodingPath(error, relative),
        );
        const maximum = Math.min(input.maxBytes ?? limits.maxReadBytes, limits.maxReadBytes);
        let selected: Buffer;
        // The caller addresses bytes, and may resume inside a character. `start`
        // is the aligned byte the returned text actually begins at, which is not
        // always `input.offset`.
        let start = input.offset;
        let size: number;
        let sha256: string;
        try {
          await authorizeCodingTool(config, { operation: 'read', path: relative });
          await assertContainedFileCurrent(root, relative, handle).catch((error: unknown) =>
            refuseMissingCodingPath(error, relative),
          );
          const metadata = await handle.stat();
          if (!metadata.isFile()) {
            codingPathRefusal('BAD_REQUEST', 'This path is not a regular file', relative, {
              hint: 'Use list_directory to see what is here.',
            });
          }
          size = metadata.size;
          // Read a few bytes past the window: a character that straddles the cut
          // is completed from those bytes instead of refused. The aligned end
          // below is where the caller resumes, so the surplus is re-read on the
          // next call rather than lost.
          const length = Math.min(maximum + 4, Math.max(0, size - input.offset));
          selected = Buffer.alloc(length);
          const { bytesRead } = await handle.read(selected, 0, length, input.offset);
          selected = selected.subarray(0, bytesRead);
          // The START is aligned the same way the end is. A byte offset is not a
          // character offset, so a caller resuming at `offset` can land on the
          // continuation bytes of a character and hand the fatal decoder a bare
          // fragment, which it refused as invalid UTF-8. Only continuation bytes
          // at the very start of the slice are skipped, and only past the first
          // byte of the file: a file whose first byte is itself a continuation
          // byte is genuinely invalid and must still reach the fatal decoder.
          if (input.offset > 0) {
            const aligned = utf8AlignedStart(selected, 0, selected.byteLength);
            start = input.offset + aligned;
            selected = selected.subarray(aligned);
          }
          // Enforce the requested window even when the lookahead reached EOF.
          // Complete at most one character at the cut; incomplete bytes at EOF
          // still reach the fatal decoder and receive a named refusal.
          if (selected.byteLength > maximum) {
            selected = selected.subarray(0, utf8AlignedEnd(selected, 0, maximum));
          }
          sha256 = await digestFile(handle, size);
        } finally {
          await handle.close();
        }
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(selected);
        } catch {
          codingPathRefusal(
            'BAD_REQUEST',
            'The selected file bytes are not valid UTF-8',
            relative,
            {
              details: { reason: 'invalid_utf8' },
              hint: 'Use a binary-capable reader or convert the file to UTF-8.',
            },
          );
        }
        const end = start + selected.byteLength;
        const truncated = end < size;
        return {
          path: relative,
          text,
          bytes: selected.byteLength,
          sha256,
          truncated,
          ...(truncated && { nextOffset: end }),
        };
      }),
  });

  const write = defineRuntimeTool({
    name: 'write_file',
    description: 'Write bounded UTF-8 content to a host-authorized workspace file.',
    identity: { serviceName: 'coding', action: 'write-file', method: 'POST' },
    input: FileWriteInputSchema,
    output: FileWriteOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input }) =>
      withCodingRoot(config.root, async (root, rootPath) => {
        const relative = boundedCodingRelativePath(rootPath, input.path, limits.maxPathBytes);
        await authorizeCodingPathChain(config, relative, root);
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
          (error: unknown) => refuseWriteConflict(error, relative),
        );
        await authorizeCodingTool(config, {
          operation: 'write',
          path: relative,
          bytes,
          overwrite: input.overwrite,
          createsDirectories,
        });
        // The lock `edit_file` holds: a write must not land between its read and its replace.
        await withCodingPathLock(root, relative, async () => {
          const parent = await openAuthorizedWriteParent(root, relative, createsDirectories);
          try {
            await assertContainedParentCurrent(root, relative, parent.handle).catch(
              (error: unknown) => refuseWriteConflict(error, relative),
            );
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
              }).catch((error: unknown) => refuseWriteConflict(error, relative));
            } else {
              if (current) {
                codingPathRefusal('CONFLICT', 'This file already exists', relative, {
                  hint: 'Pass overwrite: true to replace it, or edit_file to change part of it.',
                });
              }
              await writeContainedFile({
                parent,
                content: input.content,
                replace: false,
              }).catch((error: unknown) => refuseWriteConflict(error, relative));
            }
          } finally {
            await parent.handle.close();
          }
        });
        return { path: relative, bytes, createdDirectories: createsDirectories };
      }),
  });

  return [read, write];
}
