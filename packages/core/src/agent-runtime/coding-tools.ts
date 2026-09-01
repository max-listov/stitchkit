import path from 'node:path';
import { z } from 'zod';
import { defineRuntimeTool } from '../tools/runtime-tool';
import {
  type AgentCodingToolConfig,
  type AgentCodingToolDefinition,
  resolveCodingToolLimits,
} from './coding-tool-contract';
import { createFileCodingTools } from './coding-tool-files';
import { createListingCodingTools } from './coding-tool-listing';
import { authorizeCodingTool } from './coding-tool-paths';
import { createSearchAndPatchCodingTools } from './coding-tool-search-patch';
import { createShellCodingTool } from './coding-tool-shell';

export * from './coding-tool-contract';

export const AGENT_CODING_TOOL_NAMES = {
  editFile: 'edit_file',
  glob: 'glob',
  listDirectory: 'list_directory',
  readFile: 'read_file',
  readOutput: 'read_output',
  runCommand: 'run_command',
  searchFiles: 'search_files',
  writeFile: 'write_file',
} satisfies Readonly<Record<string, string>>;

/**
 * Direct Agent runtime-tool definitions for a host-authorized coding profile.
 * The root is a path boundary, not an OS sandbox; the host must still isolate
 * the process when it needs protection from arbitrary executable behavior.
 */
export function createAgentCodingTools(
  config: AgentCodingToolConfig,
): readonly AgentCodingToolDefinition[] {
  if (!path.isAbsolute(config.root)) throw new Error('Coding tool root must be absolute');
  for (const executable of Object.values(config.executables ?? {})) {
    if (!path.isAbsolute(executable)) {
      throw new Error('Coding tool executables must be absolute paths');
    }
  }
  const limits = resolveCodingToolLimits(config.limits);
  const artifactTools: AgentCodingToolDefinition[] = [];
  if (config.artifacts) {
    const artifacts = config.artifacts;
    artifactTools.push(
      defineRuntimeTool({
        name: AGENT_CODING_TOOL_NAMES.readOutput,
        description: 'Read a bounded byte slice from one opaque coding output artifact.',
        identity: { serviceName: 'coding', action: 'read-artifact', method: 'POST' },
        input: z
          .object({
            reference: z.string().min(1),
            offset: z.int().nonnegative().default(0),
            maxBytes: z.int().positive().optional(),
          })
          .strict(),
        output: z
          .object({
            reference: z.string().min(1),
            offset: z.int().nonnegative(),
            text: z.string(),
            bytes: z.int().nonnegative(),
            totalBytes: z.int().nonnegative().optional(),
          })
          .strict(),
        transports: ['AGENT'],
        handler: async ({ input }) => {
          const maxBytes = Math.min(
            input.maxBytes ?? limits.maxReadBytes,
            limits.maxReadBytes,
          );
          await authorizeCodingTool(config, {
            operation: 'artifact-read',
            reference: input.reference,
            offset: input.offset,
            maxBytes,
          });
          const result = await artifacts.read({
            reference: input.reference,
            offset: input.offset,
            maxBytes,
          });
          if (result.data.byteLength > maxBytes)
            throw new Error('Coding artifact store exceeded the requested byte budget');
          if (
            result.totalBytes !== undefined &&
            result.totalBytes < input.offset + result.data.byteLength
          ) {
            throw new Error('Coding artifact store returned inconsistent totalBytes');
          }
          return {
            reference: input.reference,
            offset: input.offset,
            text: new TextDecoder('utf-8', { fatal: true }).decode(result.data),
            bytes: result.data.byteLength,
            ...(result.totalBytes !== undefined && { totalBytes: result.totalBytes }),
          };
        },
      }),
    );
  }
  const commandTools = Object.keys(config.executables ?? {}).length
    ? [createShellCodingTool(config, limits)]
    : [];
  return [
    ...createFileCodingTools(config, limits),
    ...createListingCodingTools(config, limits),
    ...createSearchAndPatchCodingTools(config, limits),
    ...commandTools,
    ...artifactTools,
  ];
}
