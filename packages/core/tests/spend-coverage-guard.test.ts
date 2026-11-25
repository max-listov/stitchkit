import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertSpendCoverage,
  checkSpendCoverage,
  SpendCoverageError,
  type SpendCoveragePolicy,
  scanSpendCoverageSource,
} from '../src/entrypoints/spend/testing';

const policy: SpendCoveragePolicy = {
  modules: [
    {
      module: 'ai',
      symbols: ['streamText', 'generateText', 'generateObject', 'streamObject'],
    },
    { module: 'openai' },
    { module: '@openrouter/ai-sdk-provider' },
    { module: '@anthropic-ai/sdk' },
    { module: '@scoped/*' },
  ],
  envKeys: ['OPENROUTER_API_KEY'],
  hosts: ['openrouter.ai', 'api.openai.com'],
  allowedFiles: [{ path: 'src/spend/gateway.ts', reason: 'the one door' }],
};

const kinds = (source: string) =>
  scanSpendCoverageSource('x.ts', source, policy).map(
    (finding) => `${finding.kind}:${finding.line}`,
  );

describe('the spend coverage scan', () => {
  test.each([
    ["import { streamText } from 'ai';", 'module:1'],
    ["import { streamText as s } from 'ai';", 'module:1'],
    ["import * as ai from 'ai';", 'module:1'],
    ["import ai from 'ai';", 'module:1'],
    ["import 'openai';", 'module:1'],
    ["const m = await import('openai');", 'module:1'],
    ["const m = require('@openrouter/ai-sdk-provider');", 'module:1'],
    ["export { generateText } from 'ai';", 'module:1'],
    ["export * from 'ai';", 'module:1'],
    ["export /* c */ * as ai from 'ai';", 'module:1'],
    ["export { type LanguageModel, generateText } from 'ai';", 'module:1'],
    ["export * from 'openai';", 'module:1'],
    ["import type from 'ai';", 'module:1'],
    ["import type, { tool } from 'ai';", 'module:1'],
    ["import from from 'ai';", 'module:1'],
    ["const m = await import(/* chunk */ 'openai');", 'module:1'],
    ["export { localHelper }\nexport { generateText } from 'ai'", 'module:2'],
    ['const key = process.env.OPENROUTER_API_KEY;', 'env-key:1'],
    ["const key = process.env['OPENROUTER_API_KEY'];", 'env-key:1'],
    ['const key = Bun.env.OPENROUTER_API_KEY;', 'env-key:1'],
    ['const key = import.meta.env.OPENROUTER_API_KEY;', 'env-key:1'],
    ['const { OPENROUTER_API_KEY } = process.env;', 'env-key:1'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal JS source fixture under test.
    ['const auth = `Bearer ${process.env.OPENROUTER_API_KEY}`;', 'env-key:1'],
    ["await fetch('https://openrouter.ai/api/v1/chat');", 'host:1'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal JS source fixture under test.
    ['new WebSocket(`wss://api.openai.com/v1/${path}`);', 'host:1'],
    ["import OpenAI from 'openai/client';", 'module:1'],
    ["import { Anthropic } from '@anthropic-ai/sdk/client';", 'module:1'],
    ["import x from '@scoped/llm';", 'module:1'],
    ['const el = <div>{n}</div>; const k = process.env.OPENROUTER_API_KEY;', 'env-key:1'],
    ["i++ / 2; const m = await import('openai');", 'module:1'],
    ['import { "generateText" as run } from \'ai\';', 'module:1'],
    ["import { type as as } from 'openai';", 'module:1'],
    ["import { type as foo } from 'openai';", 'module:1'],
    ["import { type as, generateText } from 'ai';", 'module:1'],
    ["import { type as as foo, generateText } from 'ai';", 'module:1'],
    ["import { type as as as, generateText } from 'ai';", 'module:1'],
    ["import { type } from 'openai';", 'module:1'],
    ["import { as } from 'openai';", 'module:1'],
    ["import { as as foo } from 'openai';", 'module:1'],
    ["import { as, generateText } from 'ai';", 'module:1'],
    ["export { type as as } from 'openai';", 'module:1'],
    ["export { type as foo } from 'openai';", 'module:1'],
    ['export { type as "foo" } from \'openai\';', 'module:1'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal JS source fixture under test.
    ['const s = `a ${"{"}\nb`;\nconst k = process.env.OPENROUTER_API_KEY;', 'env-key:3'],
  ])('finds %s', (source, finding) => {
    expect(kinds(source)).toEqual([finding]);
  });

  test.each([
    "import type { LanguageModel } from 'ai';",
    "import { type LanguageModel, type Tool } from 'ai';",
    "import { type as } from 'openai';",
    "import { type as as foo } from 'openai';",
    "import { type as as as } from 'openai';",
    "import { type type } from 'openai';",
    "import { type type as as } from 'openai';",
    'import { type "as" as foo } from \'openai\';',
    'import { type "generateText" as run } from \'ai\';',
    "export { type as } from 'openai';",
    "export { type as as foo } from 'openai';",
    'export { type as as "foo" } from \'openai\';',
    "import { tool, jsonSchema } from 'ai';",
    '// process.env.OPENROUTER_API_KEY in a comment\n/* openrouter.ai */',
    "const pattern = /openrouter.ai/; const s = 'safe';",
    'const metaUrl = import.meta.url;',
    "export interface Config { name: string; }\nexport type { LanguageModel } from 'ai';",
    "export function helper() { return 1; }\nexport type { LanguageModel } from 'ai';",
    "export class Client { run() {} }\nexport type { LanguageModel } from 'ai';",
    "export enum Mode { Fast, Safe }\nexport type { LanguageModel } from 'ai';",
    "export { localHelper }\nexport type { LanguageModel } from 'ai'",
    "interface Foo { import: string }\nimport type { LanguageModel } from 'ai'",
    "export type {\n  LanguageModel,\n  Tool,\n} from 'ai'",
    "export type * from 'ai'",
    "export type * as ai from 'ai'",
    "import type from from 'ai'",
  ])('ignores %s', (source) => {
    expect(kinds(source)).toEqual([]);
  });

  test('a finding carries its line', () => {
    expect(kinds("const a = 1;\n\nimport { generateObject } from 'ai';")).toEqual([
      'module:3',
    ]);
  });

  test('positive re-export and edge-case import detections carry exact details', () => {
    const details = (source: string) =>
      scanSpendCoverageSource('x.ts', source, policy).map((f) => `${f.line}:${f.detail}`);
    expect(details("export * from 'ai';")).toEqual(['1:imports all of ai']);
    expect(details("export /* c */ * as ai from 'ai';")).toEqual(['1:imports all of ai']);
    expect(details("export { type LanguageModel, generateText } from 'ai';")).toEqual([
      '1:imports generateText from ai',
    ]);
    expect(details("import type from 'ai';")).toEqual(['1:imports all of ai']);
    expect(details("import from from 'ai';")).toEqual(['1:imports all of ai']);
    expect(details("const m = await import(/* chunk */ 'openai');")).toEqual([
      '1:imports openai dynamically',
    ]);
    expect(details("import { type as as } from 'openai';")).toEqual(['1:imports openai']);
    expect(details("import { type as foo } from 'openai';")).toEqual(['1:imports openai']);
    expect(details("import { type as, generateText } from 'ai';")).toEqual([
      '1:imports generateText from ai',
    ]);
    expect(details("import { type as as foo, generateText } from 'ai';")).toEqual([
      '1:imports generateText from ai',
    ]);
  });
});

describe('checking a project', () => {
  let root: string;
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stitchkit-spend-coverage-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('passes when only the allowed file reaches the provider, and is red on a bare call in a new file', async () => {
    write(
      'src/spend/gateway.ts',
      "import { createOpenRouter } from '@openrouter/ai-sdk-provider';\nconst k = process.env.OPENROUTER_API_KEY;",
    );
    write('src/agent/run.ts', "import { tool } from 'ai';\nexport const t = tool;");
    write('node_modules/ai/index.js', "import 'openai';");
    write('src/types.d.ts', "import { streamText } from 'ai';");
    const report = await assertSpendCoverage({ root, policy });
    expect(report).toEqual({ scannedFiles: 2, findings: [], staleAllowances: [] });

    write('src/agent/title.ts', "import { generateText } from 'ai';");
    const failure = await assertSpendCoverage({ root, policy }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SpendCoverageError);
    expect(failure instanceof SpendCoverageError && failure.message).toContain(
      'src/agent/title.ts:1 module imports generateText from ai',
    );
  });

  test('nested build-named directories and linked files are scanned; root build output is not', async () => {
    write('src/build/title.ts', "import { generateText } from 'ai';");
    write('dist/bundle.js', "import { generateText } from 'ai';");
    write('elsewhere/real.ts', "import { streamText } from 'ai';");
    symlinkSync(join(root, 'elsewhere/real.ts'), join(root, 'src/linked.ts'));
    write('src/spend/gateway.ts', 'const k = process.env.OPENROUTER_API_KEY;');
    const report = await checkSpendCoverage({
      root,
      policy,
      include: (file) => file.startsWith('src/'),
    });
    expect(report.findings.map((finding) => finding.file)).toEqual([
      'src/build/title.ts',
      'src/linked.ts',
    ]);
  });

  test('an allowance nothing needs any more is a finding, and so is a scan that saw no file', async () => {
    write('src/spend/gateway.ts', 'export const nothing = 1;');
    const report = await checkSpendCoverage({ root, policy });
    expect(report.staleAllowances).toEqual([
      { path: 'src/spend/gateway.ts', reason: 'the one door' },
    ]);
    await expect(assertSpendCoverage({ root, policy })).rejects.toThrow(
      'allowance no longer needed',
    );
    await expect(
      assertSpendCoverage({ root, policy, include: (file) => file.startsWith('lib/') }),
    ).rejects.toThrow('no source file was scanned');
  });
});
