import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { appDeclaration } from '../packages/config/src/declaration';
import {
  assertSupervisionAllowsShutdown,
  LOCAL_SUPERVISION,
  renderAppIdentity,
  renderEcosystem,
  renderEnvVariables,
  terminationBudgetMs,
} from './declaration';
import { ensureLocalEnvironment } from './local-env';

const root = resolve(import.meta.dir, '..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');

describe('the declaration is the source of what is derived from it', () => {
  test('the checked-in supervision files are exactly what the generator renders', () => {
    // Byte-for-byte: nothing in these files is authored, so a difference is
    // always a hand edit or a stale file — never a formatting opinion.
    expect(read('ecosystem.config.cjs')).toBe(renderEcosystem(appDeclaration, 'production'));
    expect(read('ecosystem.dev.config.cjs')).toBe(
      renderEcosystem(appDeclaration, 'development'),
    );
    expect(read('packages/config/src/app-identity.generated.ts')).toBe(renderAppIdentity());
  });

  test('env.variables in the declaration matches the one environment schema', () => {
    // Content, not bytes: roles are authored in this file and the formatter
    // owns its shape — only the derived block has to agree.
    expect(appDeclaration.env.variables).toEqual(renderEnvVariables());
  });

  test('every declared variable appears once, with a shape a reader can act on', () => {
    const derived = renderEnvVariables();
    expect(new Set(derived.map((entry) => entry.name)).size).toBe(derived.length);
    expect(derived).toContainEqual({ name: 'DATABASE_URL', shape: 'url', required: true });
    // A variable with a default is NOT required — the schema decides, not this list.
    expect(derived).toContainEqual({ name: 'BIND_HOST', shape: 'string', required: false });
    // An enum names its members: "one of an unnamed set" is useless to the
    // reader this list exists for.
    expect(derived).toContainEqual({
      name: 'LOG_FORMAT',
      shape: 'enum',
      required: false,
      members: ['pretty', 'json'],
    });
  });
});

describe('supervision may not be shorter than the code needs', () => {
  test('the budget is the whole shutdown, not just the drain', () => {
    for (const role of appDeclaration.roles) {
      // Drain, then the force that follows it, then cleanup. Comparing against
      // the drain alone is what let 15s + 5s meet a 20s kill timeout exactly.
      expect(terminationBudgetMs(role)).toBeGreaterThan(role.drainFloorMs);
    }
  });

  test('the local policy allows every role its full shutdown', () => {
    expect(() =>
      assertSupervisionAllowsShutdown(appDeclaration, LOCAL_SUPERVISION.killTimeoutMs),
    ).not.toThrow();
  });

  test('a timeout that only covers the drain is refused', () => {
    const floor = Math.max(...appDeclaration.roles.map((role) => role.drainFloorMs));
    expect(() => assertSupervisionAllowsShutdown(appDeclaration, floor)).toThrow(
      /killed mid-shutdown/,
    );
  });

  test('a timeout one millisecond under the budget is refused', () => {
    const budget = Math.max(...appDeclaration.roles.map(terminationBudgetMs));
    expect(() => assertSupervisionAllowsShutdown(appDeclaration, budget - 1)).toThrow();
    expect(() => assertSupervisionAllowsShutdown(appDeclaration, budget)).not.toThrow();
  });

  test('rendering a supervision file cannot bypass the rule', () => {
    const impatient = {
      ...appDeclaration,
      roles: appDeclaration.roles.map((role) => ({ ...role, drainFloorMs: 10 ** 9 })),
    };
    expect(() => renderEcosystem(impatient, 'production')).toThrow(/mid-shutdown/);
  });
});

describe('no repository file carries a value of the place', () => {
  // The real property, checked the same way the frontend build is checked: no
  // value that differs between two deployments may appear in a repository file.
  // A kill timeout may — supervision policy is the place's, and for the manual
  // path this repository IS the place, which is why it is one visible constant.
  ensureLocalEnvironment(root);
  const environment = parse(read('.env'));
  const placementValues = Object.values(environment).filter(
    (value) => /^\d+$/.test(value) || value.includes('://') || /\d+\.\d+\.\d+\.\d+/.test(value),
  );

  test('the fixture actually contains ports and addresses to look for', () => {
    expect(placementValues.length).toBeGreaterThan(2);
  });

  const repositoryFiles = [
    'ecosystem.config.cjs',
    'ecosystem.dev.config.cjs',
    'project.json',
    'packages/config/src/app-identity.generated.ts',
  ];
  for (const name of repositoryFiles) {
    test(`${name} names no port and no address`, () => {
      const rendered = read(name);
      for (const value of placementValues) expect(rendered).not.toInclude(value);
    });
  }

  for (const name of ['ecosystem.config.cjs', 'ecosystem.dev.config.cjs']) {
    test(`${name} says it is generated`, () => {
      expect(read(name)).toStartWith('// GENERATED FILE — do not edit.');
    });
  }
});

describe('a role starts its own process, never a launcher', () => {
  // Measured, not assumed: under PM2 a `bun run <script>` command made the API
  // role receive the stop signal twice — once from the supervisor, once
  // forwarded by the launcher — and the second press forced the shutdown, which
  // turned a declared 15s drain into 1.3ms. Direct exec: `Shutdown clean`.
  // The schema refuses the shape; this checks what actually reaches PM2.
  const modes: Array<'production' | 'development'> = ['production', 'development'];

  for (const mode of modes) {
    test(`the ${mode} supervision file execs the role directly`, () => {
      const rendered = renderEcosystem(appDeclaration, mode)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      expect(rendered).not.toMatch(/args: \["run"/);
      expect(rendered).not.toContain('--filter');
      // And the deployment's environment is not overruled by a repository file.
      expect(rendered).not.toContain('override');
    });
  }
});

describe('the drain floor has one home', () => {
  test('the API role reads its grace period from the declaration', () => {
    const source = read('packages/backend/src/index.ts');
    // A literal here would be a second number able to disagree with the one a
    // supervisor reads, which is exactly how a 30s floor met a 15s kill timeout.
    expect(source).toContain('gracePeriodMs: apiRole.drainFloorMs');
    expect(source).not.toMatch(/gracePeriodMs:\s*\d/);
  });
});

describe('an argument survives the generator intact', () => {
  test('a space and a quote reach the supervision file unmangled', () => {
    // The reason commands are argv and the generator serialises rather than
    // concatenates: `split(' ')` destroyed quoted arguments, and building
    // `'${part}'` by hand emitted invalid JavaScript for an argument
    // containing a quote.
    const awkward = {
      ...appDeclaration,
      roles: appDeclaration.roles.map((role) => ({
        ...role,
        commands: {
          ...role.commands,
          production: { executable: 'bun', args: ['run me.ts', "it's fine"] },
        },
      })),
    };

    const rendered = renderEcosystem(awkward, 'production');
    expect(rendered).toContain('["run me.ts","it\'s fine"]');

    // And it is still valid JavaScript: the file is `require`d by PM2.
    expect(
      () =>
        new Function(
          `return (${rendered.slice(rendered.indexOf('args: [')).slice(6).split(']')[0]}])`,
        ),
    ).not.toThrow();
  });
});

describe('the guidance a next agent reads names the keys that exist', () => {
  // `AGENTS.md` is not documentation about the past — it is the instruction the
  // next agent follows. It kept pointing at `env.required` for a whole release
  // after the key became `env.variables`, which is worse than a stale comment:
  // the agent goes looking for something that is not there.
  const guidance = ['AGENTS.md', 'README.md'];

  for (const file of guidance) {
    test(`${file} names no key the declaration does not have`, () => {
      const text = readFileSync(resolve(import.meta.dir, '..', file), 'utf8');
      const referenced = [...text.matchAll(/`(env|build|release|roles|identity)\.(\w+)`/g)];
      const unknown = referenced.filter(([, root, key]) => {
        const branch: unknown = Reflect.get(appDeclaration, root ?? '');
        if (typeof branch !== 'object' || branch === null) return true;
        return !Object.hasOwn(branch, key ?? '');
      });
      expect(unknown.map(([match]) => match)).toEqual([]);
    });
  }
});
