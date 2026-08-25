/**
 * The project declaration is a contract between readers that never meet: the
 * repository fills it in, the scaffolder writes the first copy, and whatever
 * builds a source and binds the artifact reads it from outside.
 *
 * The centre of this file is `REFUSED` — a table of declarations that must NOT
 * parse. An earlier version of these tests had three cases and all three
 * asserted something the schema already rejected, which is why the claim "the
 * boundary is enforced by shape" survived to a release-ready tree while a
 * connection string with credentials, a secret and an absolute machine path all
 * parsed clean. A test that only confirms what already works cannot find that.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import * as declarationModule from '../src/declaration';
import {
  findProjectRole,
  namesAMachine,
  PROJECT_DECLARATION_SCHEMA_VERSION,
  type ProjectDeclaration,
  ProjectDeclarationSchema,
  ProjectIdentitySchema,
  type ProjectRole,
  parseProjectDeclaration,
} from '../src/declaration';

const apiRole: ProjectRole = {
  name: 'api',
  workingDirectory: 'packages/backend',
  commands: {
    development: { executable: 'bun', args: ['--watch', 'src/index.ts'] },
    production: { executable: 'bun', args: ['dist/index.js'] },
  },
  listener: { portVariable: 'API_PORT', bindVariable: 'BIND_HOST', readinessPath: '/health' },
  drainFloorMs: 15_000,
};

const workerRole: ProjectRole = {
  name: 'worker',
  workingDirectory: 'packages/worker',
  commands: {
    development: { executable: 'bun', args: ['--watch', 'src/worker.ts'] },
    production: { executable: 'bun', args: ['dist/worker.js'] },
  },
  drainFloorMs: 5_000,
};

const valid: ProjectDeclaration = {
  schemaVersion: PROJECT_DECLARATION_SCHEMA_VERSION,
  kind: 'application',
  identity: {
    slug: 'talk-control',
    name: 'Talk Control',
    version: '0.1.0',
    description: { en: 'A production application.', ru: 'Production-приложение.' },
  },
  roles: [apiRole, workerRole],
  build: {
    command: { executable: 'bun', args: ['build.ts'] },
    artifacts: ['packages/backend/dist'],
  },
  requires: [{ name: 'postgres', phases: ['release', 'start'] }],
  release: {
    migrations: {
      engine: 'prisma',
      root: 'packages/db/migrations',
      lockfile: 'packages/db/migrations/migration_lock.toml',
    },
  },
  env: {
    // The listener above names `API_PORT` and `BIND_HOST`, so the contract that
    // says what a deployment must supply has to contain them. This fixture used
    // to omit both and still parse — a declaration contradicting itself, which
    // is what the cross-field check now refuses.
    variables: [
      { name: 'API_PORT', shape: 'integer', required: true },
      { name: 'BIND_HOST', shape: 'string', required: false },
      { name: 'DATABASE_URL', shape: 'url', required: true },
      { name: 'LOG_FORMAT', shape: 'enum', required: false, members: ['pretty', 'json'] },
    ],
  },
};

/** Replace the production command of the API role. */
function withCommand(executable: string, args: string[]): unknown {
  return {
    ...valid,
    roles: [
      { ...apiRole, commands: { ...apiRole.commands, production: { executable, args } } },
    ],
  };
}

function withListener(readinessPath: string): unknown {
  return {
    ...valid,
    roles: [
      {
        ...apiRole,
        listener: { portVariable: 'API_PORT', bindVariable: 'BIND_HOST', readinessPath },
      },
    ],
  };
}

function withArtifact(artifact: string): unknown {
  return { ...valid, build: { command: valid.build?.command, artifacts: [artifact] } };
}

const digest = `sha256:${'a'.repeat(64)}`;

function withListenerBinding(portVariable: string, bindVariable: string): unknown {
  return {
    ...valid,
    roles: [
      {
        ...apiRole,
        listener: { portVariable, bindVariable, readinessPath: '/health' },
      },
    ],
  };
}

function withEnvShape(name: string, shape: string): unknown {
  return {
    ...valid,
    env: {
      variables: valid.env.variables.map((entry) =>
        entry.name === name ? { ...entry, shape } : entry,
      ),
    },
  };
}

function withBuildInputs(inputs: unknown): unknown {
  return {
    ...valid,
    build: { command: valid.build?.command, artifacts: ['packages/backend/dist'], inputs },
  };
}

/**
 * Declarations that must be refused, and why each one exists.
 *
 * Every entry below is a shape that PARSED CLEAN before this table was written.
 */
const REFUSED: Array<[string, unknown]> = [
  // ─── unknown keys are a disagreement, not noise ───────────────────────────
  ['an unknown key at the top level', { ...valid, deployTo: 'prod.example.com' }],
  [
    'a typo in an optional role field, which would silently drop the listener',
    { ...valid, roles: [{ ...apiRole, listner: {} }] },
  ],
  [
    'an unknown key inside identity',
    { ...valid, identity: { ...valid.identity, homepage: 'example.com' } },
  ],

  // ─── a command is argv, and carries no value of the deployment ────────────
  ['a launcher instead of the role process', withCommand('bun', ['run', 'start'])],
  [
    'a workspace filter, whose signal never reaches the role',
    withCommand('bun', ['--filter', '@app/api', 'start']),
  ],
  ['an absolute machine path as an argument', withCommand('node', ['/srv/app/index.js'])],
  ['an absolute executable', withCommand('/usr/local/bin/serve', ['x.ts'])],
  [
    'a secret smuggled in as an assignment',
    withCommand('env', ['API_TOKEN=sk-live-abc', 'bun', 'x.ts']),
  ],
  ['a bare port number', withCommand('bun', ['x.ts', '--port', '8080'])],
  ['a bare IP address', withCommand('bun', ['x.ts', '--host', '10.0.0.5'])],
  ['a host and port', withCommand('bun', ['x.ts', '--upstream', 'db.internal:5432'])],
  ['an absolute address', withCommand('bun', ['x.ts', '--api', 'https://api.example'])],

  // ─── a path names a revision, never a filesystem ──────────────────────────
  ['an absolute build artifact', withArtifact('/srv/app/dist')],
  ['a Windows build artifact', withArtifact('C:\\srv\\app')],
  ['a backslash climb', withArtifact('..\\outside')],
  ['a POSIX climb', withArtifact('../outside')],
  ['a home-relative path', withArtifact('~/secrets')],

  // ─── the fields a reviewer would not think to check ───────────────────────
  //
  // Every one of these parsed clean while the text beside the schema said
  // "**Every** remaining free string is checked against `namesAMachine`" — the
  // filter simply was not applied there. Found by a reviewer, not by the author
  // of the sentence, which is the second time on this exact claim.
  [
    'an address in the project name',
    { ...valid, identity: { ...valid.identity, name: 'api at 10.0.0.5:5432' } },
  ],
  [
    'a connection string in a description',
    {
      ...valid,
      identity: {
        ...valid.identity,
        description: { en: 'postgres://u:p@db.internal:5432/x' },
      },
    },
  ],
  [
    'an address hiding in a locale tag',
    {
      ...valid,
      identity: { ...valid.identity, description: { 'https://evil.example': 'hi' } },
    },
  ],
  [
    'a connection string among enum members',
    {
      ...valid,
      env: {
        variables: [
          ...valid.env.variables.filter((entry) => entry.name !== 'LOG_FORMAT'),
          {
            name: 'LOG_FORMAT',
            shape: 'enum',
            required: false,
            members: ['pretty', 'postgres://u:p@10.0.0.5/x'],
          },
        ],
      },
    },
  ],

  // ─── an inline value is a value, whatever punctuation carries it ──────────
  //
  // Every entry below came from a REVIEWER, not from me — and every one parsed
  // clean against a table I had built myself and mutation-verified. That is the
  // whole lesson: a table of refusals written by the author of the rules tests
  // the shapes the author already thought of.
  ['a port hidden in an inline value', withCommand('bun', ['--port=8080'])],
  ['a secret hidden in an inline value', withCommand('bun', ['--token=sk-live-secret'])],
  [
    'a machine path hidden in an inline value',
    withCommand('bun', ['--config=/srv/app/config.json']),
  ],
  ['an inline value with a single dash', withCommand('bun', ['-c=/etc/app.conf'])],
  ['an inline value with no dashes at all', withCommand('bun', ['config=/etc/app.conf'])],
  ['an assignment whose name starts with an underscore', withCommand('bun', ['_API_TOKEN=s'])],
  ['an assignment behind a colon', withCommand('bun', ['--set:key=value'])],
  ['an assignment behind a bracket', withCommand('bun', ['--opt[k]=v'])],
  ['a port written as a separate argument', withCommand('bun', ['--port', '8080'])],
  ['a port behind the short flag', withCommand('bun', ['-p', '3000'])],
  ['a listen address flag', withCommand('bun', ['--listen', '9000'])],

  // ─── a listener must exist in the contract that supplies it ───────────────
  [
    'a listener naming a port variable the env contract does not declare',
    withListenerBinding('WEB_PORT', 'BIND_HOST'),
  ],
  [
    'a listener naming a bind variable the env contract does not declare',
    withListenerBinding('API_PORT', 'WEB_HOST'),
  ],
  [
    'a port variable declared as something other than an integer',
    withEnvShape('API_PORT', 'string'),
  ],
  ['a bind variable declared as an integer', withEnvShape('BIND_HOST', 'integer')],
  [
    'a port and a bind address pointing at one variable',
    withListenerBinding('API_PORT', 'API_PORT'),
  ],

  // ─── build data is an input only once it is named AND pinned ──────────────
  [
    'a build input with no digest — a filename that promises nothing',
    withBuildInputs([{ name: 'catalogue', path: 'data/catalogue.json' }]),
  ],
  [
    'a build input digested with something other than sha256',
    withBuildInputs([{ name: 'catalogue', path: 'data/catalogue.json', digest: 'md5:abc' }]),
  ],
  [
    'a truncated sha256 digest',
    withBuildInputs([
      { name: 'catalogue', path: 'data/catalogue.json', digest: `sha256:${'a'.repeat(63)}` },
    ]),
  ],
  [
    'an uppercase digest, which compares unequal to the same bytes hashed twice',
    withBuildInputs([
      { name: 'catalogue', path: 'data/catalogue.json', digest: `sha256:${'A'.repeat(64)}` },
    ]),
  ],
  [
    'a build input pointing at a live source of data rather than a frozen export',
    withBuildInputs([
      { name: 'catalogue', path: 'postgresql://user:pw@db.example:5432/app', digest },
    ]),
  ],
  [
    'a build input reaching outside the source',
    withBuildInputs([{ name: 'catalogue', path: '/srv/exports/catalogue.json', digest }]),
  ],
  [
    'two build inputs sharing a name — a failure could then name either',
    withBuildInputs([
      { name: 'catalogue', path: 'data/one.json', digest },
      { name: 'catalogue', path: 'data/two.json', digest },
    ]),
  ],
  [
    'an unknown key inside a build input',
    withBuildInputs([
      { name: 'catalogue', path: 'data/catalogue.json', digest, refreshedAt: '2026-08-25' },
    ]),
  ],
  [
    'an absolute address in the build command',
    {
      ...valid,
      build: {
        command: { executable: 'curl', args: ['https://internal/key'] },
        artifacts: ['dist'],
      },
    },
  ],

  // ─── the remaining free strings ───────────────────────────────────────────
  ['a protocol-relative host as a readiness path', withListener('//evil.example/health')],
  [
    'a connection string with credentials as a migration engine',
    {
      ...valid,
      release: {
        migrations: {
          engine: 'postgres://u:p@10.0.0.5:5432/db',
          root: 'db',
          lockfile: 'db/l.toml',
        },
      },
    },
  ],
  [
    'a port number in place of a variable name',
    {
      ...valid,
      roles: [
        {
          ...apiRole,
          listener: {
            portVariable: '3210',
            bindVariable: 'BIND_HOST',
            readinessPath: '/health',
          },
        },
      ],
    },
  ],

  // ─── structural truths ────────────────────────────────────────────────────
  ['a library that declares roles', { ...valid, kind: 'library' }],
  ['an application with no roles', { ...valid, roles: [] }],
  ['two roles sharing a name', { ...valid, roles: [apiRole, apiRole] }],
  [
    'a requirement named twice instead of listing its phases',
    {
      ...valid,
      requires: [
        { name: 'postgres', phases: ['release'] },
        { name: 'postgres', phases: ['start'] },
      ],
    },
  ],
  [
    'a phase listed twice',
    { ...valid, requires: [{ name: 'postgres', phases: ['start', 'start'] }] },
  ],
  [
    'an enum variable with no members, which tells a reader nothing',
    { ...valid, env: { variables: [{ name: 'LOG_FORMAT', shape: 'enum', required: false }] } },
  ],
  [
    'members on a variable that is not an enum',
    {
      ...valid,
      env: {
        variables: [{ name: 'DATABASE_URL', shape: 'url', required: true, members: ['x'] }],
      },
    },
  ],
  [
    'the same variable declared twice',
    {
      ...valid,
      env: {
        variables: [
          { name: 'DATABASE_URL', shape: 'url', required: true },
          { name: 'DATABASE_URL', shape: 'string', required: false },
        ],
      },
    },
  ],
  [
    'a slug that cannot become a process name',
    { ...valid, identity: { ...valid.identity, slug: 'Talk Control' } },
  ],
  [
    'a description in no locale at all',
    { ...valid, identity: { ...valid.identity, description: {} } },
  ],
  ['a missing release key', { ...valid, release: undefined }],
];

describe('the boundary rule is enforced by shape', () => {
  test('the fixture the table mutates is itself valid', () => {
    // Without this, a typo in the fixture would make every refusal below pass
    // for the wrong reason.
    expect(parseProjectDeclaration(valid)).toEqual(valid);
  });

  for (const [reason, declaration] of REFUSED) {
    test(`refuses ${reason}`, () => {
      expect(() => parseProjectDeclaration(declaration)).toThrow();
    });
  }
});

describe('namesAMachine', () => {
  test('names the reason, so an error can say what is wrong', () => {
    expect(namesAMachine('https://api.example')).toBe('an absolute address');
    expect(namesAMachine('//host/path')).toBe('a protocol-relative host');
    expect(namesAMachine('~/secrets')).toBe('a home-relative path');
    expect(namesAMachine('C:\\app')).toBe('a Windows drive path');
    expect(namesAMachine('10.0.0.5')).toBe('an IP address');
    expect(namesAMachine('db.internal:5432')).toBe('a host and port');
  });

  test('leaves ordinary code alone', () => {
    for (const value of [
      'dist/index.js',
      'packages/backend',
      'scripts/serve.ts',
      'production',
      '--watch',
      'prisma',
    ]) {
      expect(namesAMachine(value)).toBeUndefined();
    }
  });
});

describe('project declaration', () => {
  test('refuses an unrecognised schema version before reading any field', () => {
    // The rest of the object is nonsense on purpose: a newer declaration must
    // report as a version this build cannot serve, never as a broken file.
    expect(() =>
      parseProjectDeclaration({ schemaVersion: PROJECT_DECLARATION_SCHEMA_VERSION + 1 }),
    ).toThrow(/schema version 2 is not supported/);
  });

  test('refuses a declaration with no schema version at all', () => {
    const { schemaVersion, ...unversioned } = valid;
    expect(schemaVersion).toBe(PROJECT_DECLARATION_SCHEMA_VERSION);
    expect(() => parseProjectDeclaration(unversioned)).toThrow();
  });

  test('a project narrows by extending, not by restating', () => {
    const bilingual = ProjectDeclarationSchema.safeExtend({
      identity: ProjectIdentitySchema.safeExtend({
        description: z.object({ en: z.string().trim().min(1), ru: z.string().trim().min(1) }),
      }),
    });
    const englishOnly = {
      ...valid,
      identity: { ...valid.identity, description: { en: 'A production application.' } },
    };

    const bilingualInput = {
      ...valid,
      identity: {
        ...valid.identity,
        description: { en: 'A production application.', ru: 'Production-приложение.' },
      },
    };

    expect(bilingual.parse(bilingualInput)).toEqual(bilingualInput);
    expect(parseProjectDeclaration(englishOnly)).toEqual(englishOnly);
    expect(() => bilingual.parse(englishOnly)).toThrow();
    // Narrowing must not cost the boundary checks the base schema carries.
    expect(() => bilingual.parse({ ...bilingualInput, kind: 'library' })).toThrow(
      /library declares none/,
    );
  });
});

describe('roles', () => {
  test('a role may have no listener at all', () => {
    const worker = findProjectRole(parseProjectDeclaration(valid), 'worker');
    expect(worker?.listener).toBeUndefined();
    expect(worker?.drainFloorMs).toBe(5_000);
  });

  test('readiness belongs to a role, and answering the root is a real answer', () => {
    expect(
      findProjectRole(parseProjectDeclaration(withListener('/')), 'api')?.listener,
    ).toMatchObject({ readinessPath: '/' });
  });

  test('a role runs its commands in its own directory, named inside the revision', () => {
    expect(findProjectRole(parseProjectDeclaration(valid), 'api')?.workingDirectory).toBe(
      'packages/backend',
    );
  });
});

describe('release steps', () => {
  test('migrations are declared as bytes, and a command cannot be smuggled in', () => {
    const declaration = parseProjectDeclaration(valid);
    expect(declaration.release.migrations).toEqual({
      engine: 'prisma',
      root: 'packages/db/migrations',
      lockfile: 'packages/db/migrations/migration_lock.toml',
    });
    // The point of the field: there is no way to say HOW to run them. A command
    // key is refused rather than quietly stripped.
    expect(() =>
      parseProjectDeclaration({
        ...valid,
        release: {
          migrations: { ...valid.release.migrations, command: 'prisma migrate deploy' },
        },
      }),
    ).toThrow();
  });

  test('a project with no migrations declares an empty release, not a missing one', () => {
    expect(parseProjectDeclaration({ ...valid, release: {} }).release).toEqual({});
  });
});

/**
 * Declaring yourself is optional — pinned, not promised.
 *
 * The property is worth exactly as much as the check behind it. Written down as
 * a sentence in a guide, it survives until the first import added "for
 * convenience": one framework module reading a `project.json` makes every
 * consumer that has none fail, and the failure looks like a bug in that
 * consumer rather than a broken promise here.
 *
 * Two things have to stay true, and both are mechanical: no other core module
 * may import this one, and nothing in the framework may read a declaration file
 * by name.
 */
describe('declaring yourself is optional', () => {
  const sourceRoot = join(import.meta.dir, '../src');

  async function coreSources(): Promise<string[]> {
    const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => path !== join(sourceRoot, 'declaration.ts'));
  }

  test('no other framework module imports the declaration schema', async () => {
    const offenders: string[] = [];
    for (const path of await coreSources()) {
      const source = await readFile(path, 'utf8');
      // Relative import of the leaf module, in any of the shapes a bundler
      // accepts: `./declaration`, `../declaration`, `../../declaration`.
      if (/from\s+'(?:\.\.?\/)+declaration'/.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test('nothing in the framework reads a project.json', async () => {
    const offenders: string[] = [];
    for (const path of await coreSources()) {
      const source = await readFile(path, 'utf8');
      if (source.includes('project.json')) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test('a declaration is parsed only when a caller hands one over', () => {
    // There is no `loadProjectDeclaration()`, no default path and no discovery:
    // the only way in is a value the caller already has. That is what makes the
    // absence of a file unobservable to the framework.
    const exported = Object.keys(declarationModule).filter((name) =>
      /^(load|find|discover)/.test(name),
    );
    expect(exported).toEqual(['findProjectRole']);
  });
});

describe('build inputs', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  test('a frozen export with a pinned digest is a legitimate build input', () => {
    const parsed = parseProjectDeclaration(
      withBuildInputs([{ name: 'catalogue', path: 'data/catalogue.json', digest }]),
    );
    expect(parsed.build?.inputs).toEqual([
      { name: 'catalogue', path: 'data/catalogue.json', digest },
    ]);
  });

  test('no inputs key means the build reads no data — not that nobody knows', () => {
    // The distinction matters to the side that has to decide whether this build
    // can run away from the machine that holds the database. "Absent" has to be
    // an answer, or every project is a maybe.
    expect(parseProjectDeclaration(valid).build?.inputs).toBeUndefined();
  });
});

describe('what the boundary does NOT promise', () => {
  // The counterpart to `REFUSED`, and it exists so the texts around this schema
  // stay honest. These parse, deliberately: a schema cannot tell a secret from
  // any other word, and the guarantee is that there is nowhere a value MUST go,
  // not that nobody can write one.
  const ACCEPTED_BY_DESIGN: Array<[string, string[]]> = [
    ['a hostname written as a plain word', ['db.internal']],
    ['a secret written as its own argument', ['--token', 'sk-live-secret']],
    ['a number that is not a port', ['--workers', '12']],
  ];

  for (const [reason, args] of ACCEPTED_BY_DESIGN) {
    test(`accepts ${reason}`, () => {
      expect(() => parseProjectDeclaration(withCommand('bun', args))).not.toThrow();
    });
  }

  test('a direct runtime invocation is not a script launcher', () => {
    // `deno run x.ts` executes the file; `deno task x` runs a package script.
    // Treating them alike refused the shape the rule actually wants.
    expect(() =>
      parseProjectDeclaration(withCommand('deno', ['run', 'src/index.ts'])),
    ).not.toThrow();
    expect(() => parseProjectDeclaration(withCommand('deno', ['task', 'start']))).toThrow();
    expect(() => parseProjectDeclaration(withCommand('npx', ['serve']))).toThrow();
  });
});
