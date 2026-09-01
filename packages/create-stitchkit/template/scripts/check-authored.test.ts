import { describe, expect, test } from 'bun:test';
import { inspect } from './check-authored';

describe('check:authored — assertions', () => {
  test('lets a const assertion through: it narrows and cannot launder a type', () => {
    const source = [
      "export const benchKeys = { jobs: ['bench', 'jobs'] as const };",
      "export const modes = ['fast', 'full'] as const;",
      '',
    ].join('\n');
    expect(inspect('packages/shared/src/bench.ts', source)).toEqual([]);
  });

  test('still refuses a real assertion, and the finding names what to do instead', () => {
    const findings = inspect(
      'packages/shared/src/parse.ts',
      'const parsed = JSON.parse(raw) as Payload;\n',
    );
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    // Line and file, so it is navigable…
    expect(finding).toContain('packages/shared/src/parse.ts:1');
    // …and the remedy, so the reader does not have to search for the sanctioned way.
    expect(finding).toContain('satisfies');
    expect(finding).toContain('schema at the boundary');
  });

  test('the angle-bracket form is refused too, and explicit any separately', () => {
    expect(inspect('scripts/x.ts', 'const a = <Foo>bar;\n')).toHaveLength(1);
    const anyFindings = inspect('scripts/y.ts', 'function f(a: any) { return a; }\n');
    expect(anyFindings).toHaveLength(1);
    expect(anyFindings[0]).toContain('explicit any');
  });

  test('a const assertion beside a real one reports only the real one', () => {
    const findings = inspect(
      'scripts/mixed.ts',
      "const keys = ['a'] as const;\nconst value = raw as Payload;\n",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('scripts/mixed.ts:2');
  });
});
