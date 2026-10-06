import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSources, runUpgradeCli } from '../src/entrypoints/bin/upgrade-cli';
import { parseAffectsLine, UpgradeAffectsError } from '../src/internal/upgrade-affects';
import { planUpgrade } from '../src/internal/upgrade-plan';
import { scanStitchkitImports, upgradeVerdicts } from '../src/internal/upgrade-usage';

describe('the Affects line', () => {
  test('reads names with qualifiers, behaviour, any import and shared entrypoints', () => {
    expect(
      parseAffectsLine(
        "`stitchkit/files/packaging` createNativePackaging(delivery: 'embedded'), NativePackagingAsset; `stitchkit/process` behaviour; `stitchkit/old` *",
      ),
    ).toEqual([
      {
        entrypoint: 'stitchkit/files/packaging',
        kind: 'symbols',
        symbols: [
          { name: 'createNativePackaging', qualifier: "delivery: 'embedded'" },
          { name: 'NativePackagingAsset' },
        ],
      },
      { entrypoint: 'stitchkit/process', kind: 'behaviour' },
      { entrypoint: 'stitchkit/old', kind: 'any-import' },
    ]);
    expect(parseAffectsLine('`stitchkit/contract`, `stitchkit/server` AppError')).toEqual([
      { entrypoint: 'stitchkit/contract', kind: 'symbols', symbols: [{ name: 'AppError' }] },
      { entrypoint: 'stitchkit/server', kind: 'symbols', symbols: [{ name: 'AppError' }] },
    ]);
  });

  test('a malformed line names the part that is wrong', () => {
    expect(() => parseAffectsLine('AppError')).toThrow(UpgradeAffectsError);
    expect(() => parseAffectsLine('`stitchkit/server`')).toThrow(/names no export/);
    expect(() => parseAffectsLine('`stitchkit/server` a.b')).toThrow(
      /"a\.b" is not an export/,
    );
  });
});

describe('the imports of a project', () => {
  test('named, aliased, type, namespace, re-export, bare, dynamic and require forms', () => {
    const text = [
      "import { createApplication, type ApplicationSnapshot as Snapshot } from 'stitchkit/application';",
      "import type { ManagedSchedule } from 'stitchkit/application';",
      "import * as files from 'stitchkit/files';",
      'export {',
      '  runNativeCommand,',
      "} from 'stitchkit/process';",
      "export * from 'stitchkit/telegram';",
      "import 'stitchkit/server';",
      "const lazy = await import('stitchkit/tools');",
      "const old = require('stitchkit/geo');",
      "// import { commented } from 'stitchkit/live';",
      "/* import { blocked } from 'stitchkit/live'; */",
      "import { local } from './stitchkit';",
    ].join('\n');
    expect(
      scanStitchkitImports([{ path: 'src/a.ts', text }]).map(
        (use) => `${use.line} ${use.entrypoint} ${use.name}`,
      ),
    ).toEqual([
      '1 stitchkit/application createApplication',
      '1 stitchkit/application ApplicationSnapshot',
      '2 stitchkit/application ManagedSchedule',
      '3 stitchkit/files *',
      '5 stitchkit/process runNativeCommand',
      '7 stitchkit/telegram *',
      '8 stitchkit/server *',
      '9 stitchkit/tools *',
      '10 stitchkit/geo *',
    ]);
  });
});

const CHANGELOG = `# Changelog

## [0.3.0] — 2026-01-03

### ⚠️ Breaking changes

**Who must act:** see each item.

- \`stitchkit/files/packaging\` — **embedded delivery names no paths.**
  **Who must act:** embedded builds.
  **Affects:** \`stitchkit/files/packaging\` createNativePackaging(delivery: 'embedded')
- \`stitchkit/telegram\` — **a new send reason.**
  **Affects:** \`stitchkit/telegram\` TelegramSendFailureReason
- \`stitchkit/process\` — **a stopped leader settles as stopped.**
  **Affects:** \`stitchkit/process\` behaviour

## [0.2.0] — 2026-01-01

### ⚠️ Breaking changes

**Who must act:** callers of the old constructor.

- \`stitchkit/contract\` — **errors take named options.**

## [0.1.0] — 2025-12-31
`;

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'stitchkit-upgrade-usage-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'stitchkit'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'stitchkit', 'package.json'),
    JSON.stringify({ name: 'stitchkit', version: '0.1.0' }),
  );
  // Inside node_modules: never read as project source.
  writeFileSync(
    join(root, 'node_modules', 'stitchkit', 'index.ts'),
    "import { TelegramSendFailureReason } from 'stitchkit/telegram';",
  );
  writeFileSync(
    join(root, 'src', 'build.ts'),
    "import { mkdirSync } from 'node:fs';\nimport { createNativePackaging } from 'stitchkit/files/packaging';\n",
  );
  writeFileSync(
    join(root, 'src', 'worker.ts'),
    "import { runNativeCommand } from 'stitchkit/process';\nimport { AppError } from 'stitchkit/contract';\n",
  );
  writeFileSync(join(root, 'changelog.md'), CHANGELOG);
  return root;
}

describe('the scanner reads code, not text that looks like it', () => {
  const scan = (text: string, path = 'src/a.ts') =>
    scanStitchkitImports([{ path, text }]).map(
      (use) => `${use.line}:${use.entrypoint}:${use.name}`,
    );

  test('a statement without a semicolon above an import adds nothing', () => {
    expect(scan("export const area = w * h\nimport { foo } from 'stitchkit/server'")).toEqual([
      '2:stitchkit/server:foo',
    ]);
  });

  test('an import written inside a string or a template is not a use', () => {
    expect(
      scan(
        [
          'const generated = "import { createNativePackaging } from \'stitchkit/files/packaging\'"',
          'const fixture = `',
          "import { createLiveState } from 'stitchkit/live'",
          '`',
          "const real = await import('stitchkit/tools')",
        ].join('\n'),
      ),
    ).toEqual(['5:stitchkit/tools:*']);
  });

  test('Vue and Svelte script blocks are read, their markup is not', () => {
    expect(
      scan(
        [
          "<template><p>don't import { x } from 'stitchkit/live'</p></template>",
          '<script setup lang="ts">',
          "import { createClient } from 'stitchkit'",
          '</script>',
        ].join('\n'),
        'src/Panel.vue',
      ),
    ).toEqual(['3:stitchkit:createClient']);
    expect(
      scan(
        "<script>\n  import { ApiError } from 'stitchkit'\n</script>\n<p>{x}</p>",
        'src/A.svelte',
      ),
    ).toEqual(['2:stitchkit:ApiError']);
  });
});

describe('stitchkit upgrade --cwd', () => {
  test('each item is affects, not used, behavioural or not declared', () => {
    const root = project();
    try {
      const plan = planUpgrade(CHANGELOG, '0.1.0', '0.3.0').flatMap((change) => change.items);
      const verdicts = upgradeVerdicts(
        plan,
        scanStitchkitImports([
          {
            path: 'src/build.ts',
            text: "import { createNativePackaging } from 'stitchkit/files/packaging';",
          },
          {
            path: 'src/worker.ts',
            text: "import { runNativeCommand } from 'stitchkit/process';\nimport { AppError } from 'stitchkit/contract';",
          },
        ]),
      );
      expect(
        verdicts.map(({ item, verdict }) => [item.version, item.title, verdict.kind]),
      ).toEqual([
        ['0.2.0', 'errors take named options', 'not-declared'],
        ['0.3.0', 'embedded delivery names no paths', 'affects'],
        ['0.3.0', 'a new send reason', 'not-used'],
        ['0.3.0', 'a stopped leader settles as stopped', 'behavioural'],
      ]);
      expect(plan[1]?.whoMustAct).toBe('embedded builds.');

      const { output, code } = runUpgradeCli([
        'upgrade',
        '--cwd',
        root,
        '--to',
        '0.3.0',
        '--changelog',
        join(root, 'changelog.md'),
      ]);
      expect(code).toBe(0);
      expect(output).toContain('## Does it touch this project?');
      expect(output).toContain(
        '- **0.3.0** `stitchkit/files/packaging` — embedded delivery names no paths: **affects this project**\n  - src/build.ts:2 `createNativePackaging`',
      );
      expect(output).toContain('a new send reason: **not used here**');
      expect(output).toContain(
        'a stopped leader settles as stopped: **behavioural — check by hand**\n  - src/worker.ts',
      );
      expect(output).toContain(
        'errors take named options: **not declared — check by hand**\n  - src/worker.ts',
      );

      const json = runUpgradeCli([
        'upgrade',
        '--cwd',
        root,
        '--to',
        '0.3.0',
        '--changelog',
        join(root, 'changelog.md'),
        '--json',
      ]);
      const document = JSON.parse(json.output);
      expect(document.from).toBe('0.1.0');
      expect(document.items.map((item: { verdict: string }) => item.verdict)).toEqual([
        'not-declared',
        'affects',
        'not-used',
        'behavioural',
      ]);
      expect(document.items[1].uses).toEqual([
        {
          path: 'src/build.ts',
          line: 2,
          entrypoint: 'stitchkit/files/packaging',
          name: 'createNativePackaging',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a directory or file the process may not read is reported as unscanned, not a crash', () => {
    const root = project();
    const denied = (path: string) =>
      Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: 'EACCES',
      });
    try {
      const { sources, unscanned } = projectSources(root, {
        readdir: (path) => {
          if (path.endsWith('locked')) throw denied(path);
          const entries = readdirSync(path, { withFileTypes: true });
          return path === join(root, 'src')
            ? [
                ...entries,
                Object.assign(Object.create(Object.getPrototypeOf(entries[0])), {
                  name: 'locked',
                  parentPath: path,
                  isDirectory: () => true,
                  isFile: () => false,
                }),
              ]
            : entries;
        },
        readFile: (path) => {
          if (path.endsWith('worker.ts')) throw denied(path);
          return readFileSync(path, 'utf8');
        },
      });
      expect(unscanned).toEqual([
        { path: 'src/locked', code: 'EACCES' },
        { path: 'src/worker.ts', code: 'EACCES' },
      ]);
      expect(sources.map((source) => source.path)).toEqual(['src/build.ts']);
      // Any other failure is not a permission question and still ends the command.
      expect(() =>
        projectSources(root, {
          readdir: () => {
            throw Object.assign(new Error('EIO'), { code: 'EIO' });
          },
          readFile: () => '',
        }),
      ).toThrow('EIO');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the text and JSON outputs name what was not scanned', () => {
    if (process.getuid?.() === 0) return void expect(process.getuid?.()).toBe(0);
    const root = project();
    const locked = join(root, 'src', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const args = [
        'upgrade',
        '--cwd',
        root,
        '--to',
        '0.3.0',
        '--changelog',
        join(root, 'changelog.md'),
      ];
      expect(runUpgradeCli(args).output).toContain('- src/locked (EACCES)');
      expect(JSON.parse(runUpgradeCli([...args, '--json']).output).unscanned).toEqual([
        { path: 'src/locked', code: 'EACCES' },
      ]);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the shipped changelog's items from 0.104.0 on all declare what they touch", () => {
    const changelog = readFileSync(join(import.meta.dir, '../../../CHANGELOG.md'), 'utf8');
    const items = planUpgrade(changelog, '0.103.13', '0.107.0').flatMap(
      (change) => change.items,
    );
    expect(items.length).toBeGreaterThan(20);
    expect(
      items.filter((item) => item.affects === undefined).map((item) => item.title),
    ).toEqual([]);
  });
});

describe('what the scanner must not miss', () => {
  const scan = (text: string, path = 'src/a.ts') =>
    scanStitchkitImports([{ path, text }]).map(
      (use) => `${use.line}:${use.entrypoint}:${use.name}`,
    );

  test('a byte order mark before the first import does not hide it', () => {
    expect(
      scan("\uFEFFimport { createNativePackaging } from 'stitchkit/files/packaging'"),
    ).toEqual(['1:stitchkit/files/packaging:createNativePackaging']);
  });

  test('an import after a closing brace on the same line is read', () => {
    expect(scan("const f = () => {}; import { a } from 'stitchkit'\n")).toEqual([
      '1:stitchkit:a',
    ]);
    expect(scan("function f() {} import 'stitchkit/telegram'")).toEqual([
      '1:stitchkit/telegram:*',
    ]);
  });

  test('a very large file is read in linear time', () => {
    const text = `${"import { a } from 'stitchkit'\n".repeat(20_000)}`;
    const started = performance.now();
    const found = scanStitchkitImports([{ path: 'src/big.ts', text }]);
    expect(found).toHaveLength(20_000);
    expect(found.at(-1)?.line).toBe(20_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('build output beside a package.json is skipped, a build folder inside src is source', () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-scan-'));
    try {
      const write = (path: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), "import { x } from 'stitchkit'\n");
      };
      writeFileSync(join(root, 'package.json'), '{}');
      mkdirSync(join(root, 'packages/app'), { recursive: true });
      write('src/build/steps.ts');
      write('src/out/report.ts');
      write('dist/bundle.js');
      write('build/bundle.js');
      writeFileSync(join(root, 'packages/app/package.json'), '{}');
      write('packages/app/dist/bundle.js');
      write('packages/app/src/index.ts');
      write('node_modules/x/index.js');
      const { sources } = projectSources(root);
      expect(sources.map((source) => source.path).sort()).toEqual([
        'packages/app/src/index.ts',
        'src/build/steps.ts',
        'src/out/report.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
