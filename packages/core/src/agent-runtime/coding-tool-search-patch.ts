import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict } from '../contract/errors';
import {
  assertContainedParentCurrent,
  openContainedParent,
  openContainedParentFile,
} from '../internal/contained-files';
import { readContainedUtf8Handle } from '../internal/contained-read';
import { writeContainedFile } from '../internal/contained-write';
import { defineRuntimeTool } from '../tools/runtime-tool';
import type {
  AgentCodingToolConfig,
  AgentCodingToolDefinition,
  AgentCodingToolLimits,
} from './coding-tool-contract';
import {
  authorizeCodingPathChain,
  authorizeCodingTool,
  boundedCodingRelativePath,
  textOccurrences,
  withCodingPathLock,
  withCodingRoot,
} from './coding-tool-paths';
import {
  codingPathRefusal,
  refuseMissingCodingPath,
  refuseWriteConflict,
} from './coding-tool-refusals';
import { createSearchCodingTool } from './coding-tool-search';

/**
 * One exact-snippet edit.
 *
 * `expectedSha256` is optional. It used to be required, and requiring it is
 * what made this tool unusable for half of a nine-model run: the model had to
 * carry a 64-hex digest from its last read into every edit, and a `dryRun`
 * default of `true` made an edit two calls whose protocol the schema never
 * showed. `oldText` is itself a freshness guard for the region being changed —
 * it cannot match text that is no longer there — and a caller that wants the
 * stronger whole-file guarantee still passes the digest `read_file` returns.
 */
const EditInputSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
    expectedSha256: z.string().length(64).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();
const EditOutputSchema = z
  .object({
    path: z.string().min(1),
    baseSha256: z.string().length(64),
    sha256: z.string().length(64),
    replacements: z.int().positive(),
    bytes: z.int().nonnegative(),
    applied: z.boolean(),
  })
  .strict();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `edit_file`: replace an exact snippet, read and written under one path lock. */
async function editFile(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
  input: z.output<typeof EditInputSchema>,
): Promise<z.input<typeof EditOutputSchema>> {
  return withCodingRoot(config.root, async (root, rootPath) => {
    const relative = boundedCodingRelativePath(rootPath, input.path, limits.maxPathBytes);
    await authorizeCodingPathChain(config, relative, root);
    const parent = await openContainedParent(root, relative).catch((error: unknown) =>
      refuseMissingCodingPath(error, relative),
    );
    try {
      // Everything from the read to the write happens under one lock, against
      // content read inside it. Dropping the mandatory digest removed the
      // check that used to make a stale computation visible, so the window it
      // guarded has to be closed rather than narrowed: two concurrent edits of
      // different snippets in one file would otherwise each build a whole new
      // file from the same v0 and the second write would erase the first.
      // The lock is process-local — the nine-agents-in-one-process case is
      // covered, two processes over one workspace are not.
      return await withCodingPathLock(root, relative, async () => {
        const readCurrent = async () => {
          const handle = await openContainedParentFile(parent).catch((error: unknown) =>
            refuseMissingCodingPath(error, relative),
          );
          return readContainedUtf8Handle(handle, limits.maxWriteBytes).finally(() =>
            handle.close(),
          );
        };
        // A miss, a count or a digest is an oracle over the file, one guess at a time: a host that
        // refuses to read it answers here, before anything about its content leaves this call.
        await authorizeCodingTool(config, { operation: 'read', path: relative });
        const read = await readCurrent();
        const source = read.text;
        const baseSha256 = sha256(source);
        if (input.expectedSha256 !== undefined && baseSha256 !== input.expectedSha256) {
          conflict('The file changed since it was read', {
            message: 'The file changed since it was read',
            path: relative,
            expectedSha256: input.expectedSha256,
            actualSha256: baseSha256,
          });
        }
        const count = textOccurrences(source, input.oldText);
        if (count === 0) {
          codingPathRefusal('NOT_FOUND', 'oldText does not appear in this file', relative, {
            details: { occurrences: 0 },
            hint: 'Read the file and copy the snippet exactly, including indentation.',
          });
        }
        if (!input.replaceAll && count !== 1) {
          codingPathRefusal(
            'CONFLICT',
            `oldText appears ${count} times, so the edit is ambiguous`,
            relative,
            {
              details: { occurrences: count },
              hint: 'Lengthen the snippet until it is unique, or pass replaceAll: true.',
            },
          );
        }
        const replacements = input.replaceAll ? count : 1;
        const literalReplacement = () => input.newText;
        const changed = input.replaceAll
          ? source.replaceAll(input.oldText, literalReplacement)
          : source.replace(input.oldText, literalReplacement);
        const bytes = Buffer.byteLength(changed);
        const resultSha256 = sha256(changed);
        if (bytes > limits.maxWriteBytes) {
          codingPathRefusal(
            'BAD_REQUEST',
            `The result would be ${bytes} bytes, over the ${limits.maxWriteBytes}-byte limit`,
            relative,
            {
              details: { bytes, maxWriteBytes: limits.maxWriteBytes },
              hint: 'Make a smaller edit, or split the file.',
            },
          );
        }
        await authorizeCodingTool(config, {
          operation: 'edit',
          path: relative,
          baseSha256,
          resultSha256,
          resultBytes: bytes,
          replacements,
          dryRun: input.dryRun,
        });
        await assertContainedParentCurrent(root, relative, parent.handle).catch(
          (error: unknown) => refuseWriteConflict(error, relative),
        );
        if (!input.dryRun) {
          // The host may have taken minutes; `run_command` and other processes do not hold this lock.
          if (sha256((await readCurrent()).text) !== baseSha256) {
            conflict('The file changed since it was read', {
              message: 'The file changed since it was read',
              path: relative,
            });
          }
          await writeContainedFile({
            parent,
            content: changed,
            replace: true,
            mode: read.mode,
          }).catch((error: unknown) => refuseWriteConflict(error, relative));
        }
        return {
          path: relative,
          baseSha256,
          sha256: resultSha256,
          replacements,
          bytes,
          applied: !input.dryRun,
        };
      });
    } finally {
      await parent.handle.close();
    }
  });
}

export function createSearchAndPatchCodingTools(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): readonly AgentCodingToolDefinition[] {
  const edit = defineRuntimeTool({
    name: 'edit_file',
    description: 'Replace an exact snippet in one workspace file.',
    identity: { serviceName: 'coding', action: 'edit-file', method: 'POST' },
    input: EditInputSchema,
    output: EditOutputSchema,
    transports: ['AGENT'],
    handler: ({ input }) => editFile(config, limits, input),
  });
  return [createSearchCodingTool(config, limits), edit];
}
