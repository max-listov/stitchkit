import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineRuntimeTool } from '../tools/runtime-tool';
import type { AgentCodingToolDefinition } from './coding-tool-contract';
import { readContainedUtf8File, walkContainedFiles } from './contained-files';
import type { AgentHarnessResource, AgentHarnessResourceResult } from './harness-contract';

export const AgentHarnessFileRootSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    path: z.string().min(1),
    kind: z.enum(['instruction', 'skill', 'resource']),
  })
  .strict();

export const AgentHarnessFileLimitsSchema = z
  .object({
    maxFiles: z.int().positive(),
    maxDepth: z.int().nonnegative(),
    maxFileBytes: z.int().positive(),
    maxTotalBytes: z.int().positive(),
  })
  .strict();

export type AgentHarnessFileRoot = z.infer<typeof AgentHarnessFileRootSchema>;
export type AgentHarnessFileLimits = z.infer<typeof AgentHarnessFileLimitsSchema>;

export interface AgentHarnessFileResources {
  load(): Promise<AgentHarnessResourceResult>;
  runtimeTools: readonly AgentCodingToolDefinition[];
}

const DEFAULT_LIMITS: AgentHarnessFileLimits = {
  maxFiles: 128,
  maxDepth: 8,
  maxFileBytes: 262_144,
  maxTotalBytes: 1_048_576,
};

function metadata(text: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text.replaceAll('\r\n', '\n'));
  if (!match) throw new Error(`Skill ${fallbackName} requires YAML frontmatter`);
  const fields = new Map<string, string>();
  const lines = (match[1] ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] ?? '';
    if (fields.has(key)) throw new Error(`Skill ${fallbackName} repeats ${key} metadata`);
    const raw = field[2] ?? '';
    if (raw === '>' || raw === '|') {
      const block: string[] = [];
      while ((lines[index + 1] ?? '').match(/^\s+/)) {
        index += 1;
        block.push((lines[index] ?? '').replace(/^\s+/, ''));
      }
      fields.set(key, raw === '>' ? block.join(' ').trim() : block.join('\n').trim());
    } else if (raw.startsWith('"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Skill ${fallbackName} has invalid quoted ${key} metadata`);
      }
      if (typeof parsed !== 'string')
        throw new Error(`Skill ${fallbackName} has non-string ${key} metadata`);
      fields.set(key, parsed);
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
      fields.set(key, raw.slice(1, -1).replaceAll("''", "'"));
    } else {
      fields.set(key, raw.trim());
    }
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) {
    throw new Error(`Skill ${fallbackName} requires name and description metadata`);
  }
  return { name, description };
}

function safeName(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Discover explicit roots once per load. Instructions are eager; skills and ordinary resources
 * expose bounded summaries and keep their exact text behind a direct typed read operation.
 */
export function createAgentHarnessFileResources(config: {
  roots: readonly AgentHarnessFileRoot[];
  limits?: Partial<AgentHarnessFileLimits>;
}): AgentHarnessFileResources {
  const roots = AgentHarnessFileRootSchema.array().min(1).parse(config.roots);
  const ids = new Set<string>();
  for (const root of roots) {
    if (!path.isAbsolute(root.path))
      throw new Error('Agent harness resource roots must be absolute');
    if (ids.has(root.id))
      throw new Error(`Duplicate Agent harness resource root id: ${root.id}`);
    ids.add(root.id);
  }
  const limits = AgentHarnessFileLimitsSchema.parse({ ...DEFAULT_LIMITS, ...config.limits });
  let exact: ReadonlyMap<string, AgentHarnessResource> = new Map();
  let loaded: Promise<AgentHarnessResourceResult> | undefined;

  const discover = async (): Promise<AgentHarnessResourceResult> => {
    const next = new Map<string, AgentHarnessResource>();
    const projected: AgentHarnessResource[] = [];
    let totalBytes = 0;
    let fileCount = 0;
    for (const root of roots) {
      const resolvedRoot = await realpath(root.path);
      const files = await walkContainedFiles({
        root: resolvedRoot,
        maxDepth: limits.maxDepth,
        maxFiles: limits.maxFiles - fileCount,
      });
      fileCount += files.length;
      for (const file of files) {
        if (root.kind === 'skill' && path.basename(file.absolute) !== 'SKILL.md') continue;
        const read = await readContainedUtf8File(file.absolute, limits.maxFileBytes);
        totalBytes += read.bytes;
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error('Agent harness resources exceed maxTotalBytes');
        }
        const text = read.text;
        const provenance = `${root.id}:${safeName(file.relative)}`;
        const skill = root.kind === 'skill' ? metadata(text, provenance) : undefined;
        const name = skill?.name ?? safeName(file.relative);
        if (next.has(name)) throw new Error(`Duplicate Agent harness resource: ${name}`);
        const resource = {
          kind: root.kind,
          name,
          text,
          provenance,
        } satisfies AgentHarnessResource;
        next.set(name, resource);
        projected.push(
          root.kind === 'instruction'
            ? resource
            : {
                ...resource,
                text:
                  root.kind === 'skill'
                    ? `Available skill: ${name} — ${skill?.description ?? ''}. Read it by exact name when needed.`
                    : `Available resource: ${name}. Read it by exact name when needed.`,
              },
        );
      }
    }
    exact = new Map(next);
    return { resources: Object.freeze([...projected]), diagnostics: [] };
  };
  const load = (): Promise<AgentHarnessResourceResult> => {
    loaded ??= discover();
    return loaded;
  };

  const readResource = defineRuntimeTool({
    name: 'read_resource',
    description: 'Read one exact discovered harness skill or resource by canonical name.',
    identity: { serviceName: 'harness', action: 'read-resource', method: 'POST' },
    input: z.object({ name: z.string().min(1) }).strict(),
    output: z
      .object({
        kind: z.enum(['instruction', 'skill', 'resource']),
        name: z.string().min(1),
        text: z.string(),
        provenance: z.string().min(1),
      })
      .strict(),
    transports: ['AGENT'],
    handler: ({ input }) => {
      const resource = exact.get(input.name);
      if (!resource)
        throw new Error('Harness resource is missing or stale; refresh discovery');
      return resource;
    },
  });

  return { load, runtimeTools: [readResource] };
}
