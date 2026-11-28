/**
 * Structural guards for I7 (zero external AI/provider SDK peers in the neutral
 * `agent-runtime` and `tools` graphs) and I8 (one step loop owned by Stitchkit,
 * never delegating to AI SDK `streamText` or `generateText`). → ADR 0336.
 */
import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';
// @ts-expect-error — plain ESM build gate script shared by Node and tests.
import * as cleanGate from '../scripts/check-agent-runtime-clean.mjs';

const { checkAgentRuntimeClean, isForbiddenAgentPeerSpecifier, PEER_FREE_AGENT_ENTRIES } =
  cleanGate;

const SRC = resolve(import.meta.dir, '../src');
const AGENT_RUNTIME_SRC = join(SRC, 'agent-runtime');
const FORBIDDEN_AI_SDK_LOOP_APIS = new Set(['streamText', 'generateText']);
const ALLOWED_AI_SDK_RUNTIME_FILES = new Set(['ai-sdk.ts', 'ai-sdk-convert.ts']);

function* tsSources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* tsSources(full);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

function findAiSdkLoopImports(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, false);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec === 'ai' || spec.startsWith('ai/')) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (FORBIDDEN_AI_SDK_LOOP_APIS.has(imported)) {
              offenders.push(`${filePath}: imports ${imported} from "${spec}"`);
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (
        (spec === 'ai' || spec.startsWith('ai/')) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          if (FORBIDDEN_AI_SDK_LOOP_APIS.has(exported)) {
            offenders.push(`${filePath}: re-exports ${exported} from "${spec}"`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

function findForbiddenPeerSpecifiers(filePath: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, false);
  const offenders: string[] = [];
  const record = (spec: string): void => {
    if (isForbiddenAgentPeerSpecifier(spec)) {
      offenders.push(`${filePath}: "${spec}"`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      record(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) {
        record(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

function writeSyntheticFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function createCleanSyntheticDist(root: string): void {
  writeSyntheticFile(
    root,
    'chunk-shared.js',
    `import { z } from 'zod';\nexport const ok = z.string();\n`,
  );
  writeSyntheticFile(
    root,
    'shared-types.d.ts',
    `import type { z } from 'zod';\nexport type Ok = z.ZodString;\n`,
  );
  for (const entry of PEER_FREE_AGENT_ENTRIES) {
    const depth = entry.split('/').length - 1;
    const prefix = '../'.repeat(depth);
    writeSyntheticFile(
      root,
      `${entry}.js`,
      `export { ok } from '${prefix}chunk-shared.js';\n`,
    );
    writeSyntheticFile(
      root,
      `${entry}.d.ts`,
      `export type { Ok } from '${prefix}shared-types.js';\n`,
    );
  }
}

describe('agent-runtime I7/I8 — no AI SDK loop or leaked external peers', () => {
  test('no source file in packages/core/src imports streamText or generateText from ai', () => {
    const offenders: string[] = [];
    for (const file of tsSources(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      offenders.push(...findAiSdkLoopImports(rel, readFileSync(file, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  test('streamText/generateText detector catches direct, aliased, and re-exported loop imports (negative control)', () => {
    expect(
      findAiSdkLoopImports('clean.ts', `import { tool, jsonSchema } from 'ai';\n`),
    ).toEqual([]);
    expect(
      findAiSdkLoopImports(
        'direct.ts',
        `import { streamText, generateText as gen } from 'ai';\nexport { streamText } from 'ai';\n`,
      ),
    ).toEqual([
      'direct.ts: imports streamText from "ai"',
      'direct.ts: imports generateText from "ai"',
      'direct.ts: re-exports streamText from "ai"',
    ]);
  });

  test('in packages/core/src/agent-runtime only ai-sdk.ts and ai-sdk-convert.ts may import external AI/provider SDKs', () => {
    const offenders: string[] = [];
    for (const file of tsSources(AGENT_RUNTIME_SRC)) {
      const rel = relative(AGENT_RUNTIME_SRC, file).replaceAll('\\', '/');
      if (ALLOWED_AI_SDK_RUNTIME_FILES.has(rel)) continue;
      offenders.push(...findForbiddenPeerSpecifiers(rel, readFileSync(file, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  test('agent-runtime source peer detector catches static, type, and dynamic external SDK imports (negative control)', () => {
    const synthetic = [
      `import type { LanguageModelV4 } from '@ai-sdk/provider';`,
      `import { createOpenRouter } from '@openrouter/ai-sdk-provider';`,
      `export type Client = import('openai').OpenAI;`,
      `export const load = () => import('@anthropic-ai/sdk');`,
    ].join('\n');
    expect(findForbiddenPeerSpecifiers('leak.ts', synthetic)).toEqual([
      'leak.ts: "@ai-sdk/provider"',
      'leak.ts: "@openrouter/ai-sdk-provider"',
      'leak.ts: "openai"',
      'leak.ts: "@anthropic-ai/sdk"',
    ]);
  });

  test('checkAgentRuntimeClean passes on a clean synthetic dist and catches direct + transitive JS and d.ts leaks', () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-agent-clean-'));
    try {
      createCleanSyntheticDist(root);
      const clean = checkAgentRuntimeClean(root);
      expect(clean.ok).toBe(true);
      expect(clean.entriesChecked).toBe(PEER_FREE_AGENT_ENTRIES.length);
      expect(clean.violations).toEqual([]);

      // Negative control 1: direct JS import from 'ai'
      writeSyntheticFile(
        root,
        'entrypoints/agent-runtime.js',
        `import { streamText } from 'ai';\nexport const run = streamText;\n`,
      );
      // Negative control 2: transitive JS chunk importing '@openrouter/ai-sdk-provider'
      writeSyntheticFile(
        root,
        'chunk-openrouter-leak.js',
        `import { createOpenRouter } from '@openrouter/ai-sdk-provider';\nexport const or = createOpenRouter;\n`,
      );
      writeSyntheticFile(
        root,
        'entrypoints/agent-runtime/openrouter.js',
        `export { or } from '../../chunk-openrouter-leak.js';\n`,
      );
      // Negative control 3: transitive .d.ts referencing '@ai-sdk/provider' and 'openai'
      writeSyntheticFile(
        root,
        'openai-types.d.ts',
        `import type { LanguageModelV4 } from '@ai-sdk/provider';\nexport type Leak = LanguageModelV4 & import('openai').OpenAI;\n`,
      );
      writeSyntheticFile(
        root,
        'entrypoints/agent-runtime/openai.d.ts',
        `export type { Leak } from '../../openai-types.js';\n`,
      );
      // Negative control 4: dynamic import of '@anthropic-ai/sdk'
      writeSyntheticFile(
        root,
        'entrypoints/agent-runtime/anthropic.js',
        `export const load = () => import('@anthropic-ai/sdk');\n`,
      );

      const poisoned = checkAgentRuntimeClean(root);
      expect(poisoned.ok).toBe(false);
      expect(poisoned.violations).toEqual(
        expect.arrayContaining([
          {
            entry: 'entrypoints/agent-runtime',
            kind: 'js',
            file: 'entrypoints/agent-runtime.js',
            specifier: 'ai',
          },
          {
            entry: 'entrypoints/agent-runtime/openrouter',
            kind: 'js',
            file: 'chunk-openrouter-leak.js',
            specifier: '@openrouter/ai-sdk-provider',
          },
          {
            entry: 'entrypoints/agent-runtime/openai',
            kind: 'dts',
            file: 'openai-types.d.ts',
            specifier: '@ai-sdk/provider',
          },
          {
            entry: 'entrypoints/agent-runtime/openai',
            kind: 'dts',
            file: 'openai-types.d.ts',
            specifier: 'openai',
          },
          {
            entry: 'entrypoints/agent-runtime/anthropic',
            kind: 'js',
            file: 'entrypoints/agent-runtime/anthropic.js',
            specifier: '@anthropic-ai/sdk',
          },
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
