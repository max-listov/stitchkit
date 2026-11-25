import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { defineCliCommand } from '../src/tools/cli/command';
import { type CliConfig, createCli } from '../src/tools/cli/create-cli';
import { defineRuntimeTool } from '../src/tools/runtime-tool';
import {
  ALL_OPERATION_ORIGINS,
  mountOperationOrigins,
  type OperationOrigin,
  startMcp,
} from './support/operation-origins';
import { runCliSurface } from './support/operation-transports';

const BoundedInput = z.object({
  limit: z.int().min(1).max(50).optional().describe('Page size'),
  score: z.number().gt(0).lt(10),
  key: z.string().min(1).max(12).describe('Access key'),
  names: z.array(z.string().min(20)).min(2).max(4),
  empty: z.string().min(0).max(0).optional(),
  none: z.array(z.string()).max(0).optional(),
  zero: z.number().min(0).max(0).optional(),
  query: z.string().optional(),
  mode: z.enum(['fast', 'full']).optional(),
  verbose: z.boolean().optional(),
});
let calls = 0;
const native = defineCliCommand({
  name: 'local',
  description: 'Local command',
  input: BoundedInput,
  handler: () => {
    calls += 1;
  },
});
const service = implement(
  defineContract(
    { prefix: 'limits', scope: 'public' },
    {
      search: {
        method: 'POST',
        path: '/',
        desc: 'Contract command',
        expose: ['CLI'],
        input: BoundedInput,
        tool: { name: 'search' },
      },
    },
  ),
  {
    search: () => {
      calls += 1;
    },
  },
);
const runtime = defineRuntimeTool({
  name: 'runtime',
  description: 'Runtime command',
  input: BoundedInput,
  identity: { serviceName: 'limits', action: 'runtime', method: 'POST' },
  expose: ['CLI'],
  handler: () => {
    calls += 1;
  },
});

async function run(argv: string[], config: Partial<CliConfig> = {}) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'limits',
    version: '1',
    services: [service],
    commands: [native],
    runtimeTools: () => [runtime],
    commandSettings: { local: { aliases: { l: 'limit' } } },
    ...config,
    access: config.access ?? { open: 'local-operator' },
    argv,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}

function argument(out: string, name: string): string {
  const line = out.split('\n').find((value) => value.includes(`--${name} `));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('CLI help exposes the schema limits before execution', () => {
  for (const command of ['local', 'search', 'runtime']) {
    test(`${command} shows inclusive integers and exclusive numbers without executing`, async () => {
      const before = calls;
      const { out, err, code } = await run([command, '--help']);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(calls).toBe(before);
      expect(argument(out, 'limit')).toContain('<integer> [>=1, <=50] — Page size');
      expect(argument(out, 'score')).toContain('<number> [>0, <10] (required)');
    });
  }

  test('an integer prints only the bounds its author declared', async () => {
    const integers = defineCliCommand({
      name: 'integers',
      description: 'Integer limits',
      input: z.object({
        bare: z.int().optional(),
        legacy: z.number().int().optional(),
        floor: z.int().min(1).optional(),
        positive: z.int().positive().optional(),
        ceiling: z.int().max(9).optional(),
        either: z.union([z.int().min(2), z.string().min(3)]).optional(),
      }),
      handler: () => undefined,
    });
    const { out, code } = await run(['integers', '--help'], { commands: [integers] });
    expect(code).toBe(0);
    expect(argument(out, 'bare').trimEnd().endsWith('<integer>')).toBe(true);
    expect(argument(out, 'legacy').trimEnd().endsWith('<integer>')).toBe(true);
    expect(argument(out, 'floor')).toContain('<integer> [>=1]');
    expect(argument(out, 'positive')).toContain('<integer> [>0]');
    expect(argument(out, 'ceiling')).toContain('<integer> [<=9]');
    expect(argument(out, 'either')).toContain('[any of: integer [>=2] | string [length >=3]]');
    expect(out).not.toContain('9007199254740991');
  });

  test('help asked twice, in any spelling, prints help and exits 0', async () => {
    for (const argv of [
      ['local', '-h', '--help'],
      ['local', '-h', '-h'],
      ['local', '--help', '-h'],
      ['--help', '-h'],
    ]) {
      const { out, err, code } = await run(argv);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toContain('Usage');
    }
  });

  test('length and item counts belong to their field, not its array items', async () => {
    const { out } = await run(['local', '--help']);
    expect(argument(out, 'key')).toContain(
      '<string> [length >=1, length <=12] (required) — Access key',
    );
    expect(argument(out, 'names')).toContain('<value> [items >=2, items <=4] (required)');
    expect(argument(out, 'names')).not.toContain('20');
  });

  test('zero limits survive and unconstrained fields keep their compact line', async () => {
    const { out } = await run(['local', '--help']);
    expect(argument(out, 'zero')).toContain('<number> [>=0, <=0]');
    expect(argument(out, 'empty')).toContain('<string> [length >=0, length <=0]');
    expect(argument(out, 'none')).toContain('<value> [items <=0]');
    expect(argument(out, 'query').trimEnd().endsWith('<string>')).toBe(true);
    expect(argument(out, 'query')).not.toContain('[' + 'length');
  });

  test('aliases, optionality, enums, descriptions and framework options remain visible', async () => {
    const { out } = await run(['local', '--help']);
    expect(argument(out, 'limit')).toContain('[limit] | -l, --limit');
    expect(argument(out, 'limit')).not.toContain('(required)');
    expect(argument(out, 'mode')).toContain('<fast|full>');
    expect(out).toContain('--no-verbose');
    const top = await run(['--help']);
    expect(top.out).toContain('--wait-timeout <s>');
    expect(top.out).toContain('--json');
  });

  test('application options use the same limits in top and command help', async () => {
    const globalOptions = z.object({
      budget: z.number().gt(0).max(30).optional().describe('Request budget'),
      profile: z.string().min(1).max(16).optional(),
      selected: z.array(z.string()).min(0).max(3).optional(),
    });
    for (const argv of [['--help'], ['local', '--help'], ['runtime', '--help']]) {
      const { out, code } = await run(argv, { globalOptions });
      expect(code).toBe(0);
      expect(out).toContain('Application options:');
      expect(argument(out, 'budget')).toContain('[>0, <=30]');
      expect(argument(out, 'budget')).toContain('Request budget');
      expect(argument(out, 'profile')).toContain('[length >=1, length <=16]');
      expect(argument(out, 'selected')).toContain('[items >=0, items <=3]');
    }
  });

  test('a string names its format, or its pattern when no format names it', async () => {
    const shaped = defineCliCommand({
      name: 'shaped',
      description: 'Shaped strings',
      input: z.object({
        requestKey: z.uuid().describe('Idempotency key'),
        contact: z.email().nullable(),
        callback: z.url().optional(),
        since: z.iso.datetime().optional(),
        slug: z
          .string()
          .regex(/^[a-z]+$/)
          .min(2),
        prefixed: z.string().startsWith('sk-').optional(),
        token: z.nanoid().optional(),
        plain: z.string().optional(),
      }),
      handler: () => undefined,
    });
    const globalOptions = z.object({ tenant: z.uuid().optional() });
    const { out } = await run(['shaped', '--help'], { commands: [shaped], globalOptions });
    expect(argument(out, 'requestKey')).toContain(
      '<string> [uuid] (required) — Idempotency key',
    );
    expect(argument(out, 'contact')).toContain('[any of: string [email] | null]');
    expect(argument(out, 'callback')).toContain('<string> [uri]');
    expect(argument(out, 'since')).toContain('<string> [date-time]');
    expect(argument(out, 'slug')).toContain(
      '<string> [pattern /^[a-z]+$/, length >=2] (required)',
    );
    expect(argument(out, 'tenant')).toContain('<string> [uuid]');
    // A producer's own format word tells nothing; its pattern does.
    expect(argument(out, 'prefixed')).toContain('<string> [pattern /^sk-.*/]');
    expect(argument(out, 'token')).toContain('<string> [pattern /^[a-zA-Z0-9_-]{21}$/]');
    expect(argument(out, 'plain').trimEnd().endsWith('<string>')).toBe(true);
    // The expression behind a named format stays out of the line.
    expect(out).not.toContain('0-9a-fA-F');
  });

  test('union alternatives and nullable values do not promise a conjunction', async () => {
    const alternate = defineCliCommand({
      name: 'alternate',
      description: 'Alternatives',
      input: z.object({
        value: z.union([z.number().min(1).max(5), z.string().min(10)]),
        maybe: z.string().min(1).nullable(),
        free: z.union([z.string(), z.number()]),
        either: z.union([z.array(z.string()).max(3), z.any()]),
        joined: z.intersection(z.number().min(1), z.number().max(5)),
      }),
      handler: () => undefined,
    });
    const { out } = await run(['alternate', '--help'], { commands: [alternate] });
    expect(argument(out, 'value')).toContain(
      '[any of: number [>=1, <=5] | string [length >=10]]',
    );
    expect(argument(out, 'maybe')).toContain('[any of: string [length >=1] | null]');
    expect(argument(out, 'free')).not.toContain('any of:');
    expect(argument(out, 'either')).toContain('[any of: value [items <=3] | value]');
    expect(argument(out, 'joined')).toContain('[all of: number [>=1] & number [<=5]]');
  });

  test('an MCP-discovered runtime command retains its served limits and validation', async () => {
    let remoteCalls = 0;
    const server = startMcp(
      [
        {
          name: 'discovered',
          description: 'Discovered bounds',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description: 'Page size',
              },
            },
          },
        },
      ],
      () => {
        remoteCalls += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    try {
      const runtimeTools = await mountConnections([
        defineMcpClientConnection({
          name: 'limits',
          transport: { url: server.url },
          expose: ['CLI'],
        }),
      ]);
      const config = { runtimeTools };
      const help = await run(['discovered', '--help'], config);
      expect(help.code).toBe(0);
      expect(argument(help.out, 'limit')).toContain('<integer> [>=1, <=50] — Page size');
      expect(remoteCalls).toBe(0);
      expect((await run(['discovered', '--limit', '50'], config)).code).toBe(0);
      expect(remoteCalls).toBe(1);
      for (const value of ['0', '51']) {
        expect((await run(['discovered', '--limit', value], config)).code).not.toBe(0);
        expect(remoteCalls).toBe(1);
      }
    } finally {
      await server.stop();
    }
  });

  describe('a format a server declares reaches the help of the command discovered from it', () => {
    let mounted: Awaited<ReturnType<typeof mountOperationOrigins>>;

    beforeAll(async () => {
      mounted = await mountOperationOrigins({
        serviceName: 'formats',
        specs: [
          {
            name: 'served',
            description: 'Served formats',
            method: 'GET',
            input: z.object({
              requestKey: z.uuid().describe('Idempotency key'),
              contact: z.email().nullable(),
              since: z.iso.datetime().optional(),
              callback: z.url().optional(),
            }),
            handler: () => ({ ok: true }),
          },
        ],
      });
    });

    afterAll(async () => {
      await mounted?.close();
    });

    test.each(ALL_OPERATION_ORIGINS)(
      'origin %s preserves string formats in CLI help',
      async (origin: OperationOrigin) => {
        const surface = mounted.byOrigin.get(origin);
        if (!surface) throw new Error(`missing mounted origin ${origin}`);
        if (origin === 'managed-cli-catalog') expect(surface.catalogCacheHit).toBe(true);
        const help = await runCliSurface(surface, [surface.commandName('served'), '--help']);
        expect(help.code).toBe(0);
        expect(argument(help.out, 'requestKey')).toContain(
          '<string> [uuid] (required) — Idempotency key',
        );
        expect(argument(help.out, 'contact')).toContain('[any of: string [email] | null]');
        expect(argument(help.out, 'since')).toContain('<string> [date-time]');
        expect(argument(help.out, 'callback')).toContain('<string> [uri]');
        expect(help.out).not.toContain('all of:');
        expect(help.out).not.toContain('0-9a-fA-F');
        expect(help.out).not.toContain('x-stitchkit');
      },
    );

    test('foreign server formats reach CLI help through MCP discovery', async () => {
      const foreign = {
        type: 'object',
        properties: {
          own: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' },
          bare: { type: 'string', format: 'uuid' },
          linked: { type: 'string', format: 'uri', pattern: '^https://' },
          clock: { type: 'string', format: 'time' },
          ticking: { type: 'string', format: 'time', pattern: '^1' },
          relative: { type: 'string', format: 'uri-reference' },
          mailbox: { type: ['string', 'null'], format: 'idn-email' },
          pointer: { type: 'string', format: 'json-pointer', pattern: '^/' },
          word: { type: 'string', format: 'ticket' },
          coded: { type: 'string', format: 'ticket', pattern: '^T-' },
          slug: { type: 'string', pattern: '^[a-z]+$', minLength: 2 },
          plain: { type: 'string' },
        },
        required: ['own'],
      };
      const server = startMcp([
        { name: 'foreign', description: 'Foreign formats', inputSchema: foreign },
      ]);
      try {
        const runtimeTools = await mountConnections([
          defineMcpClientConnection({
            name: 'formats',
            transport: { url: server.url },
            expose: ['CLI'],
          }),
        ]);
        const foreignHelp = await runCliSurface({ runtimeTools }, ['foreign', '--help']);
        expect(foreignHelp.code).toBe(0);
        expect(argument(foreignHelp.out, 'own')).toContain('<string> [uuid] (required)');
        expect(argument(foreignHelp.out, 'bare')).toContain('<string> [uuid]');
        expect(argument(foreignHelp.out, 'linked')).toContain('<string> [uri]');
        expect(argument(foreignHelp.out, 'clock')).toContain('<string> [time]');
        expect(argument(foreignHelp.out, 'ticking')).toContain('<string> [time]');
        expect(argument(foreignHelp.out, 'relative')).toContain('<string> [uri-reference]');
        expect(argument(foreignHelp.out, 'mailbox')).toContain(
          '[any of: string [idn-email] | null]',
        );
        expect(argument(foreignHelp.out, 'pointer')).toContain('<string> [json-pointer]');
        expect(argument(foreignHelp.out, 'word')).toContain('<string> [ticket]');
        expect(argument(foreignHelp.out, 'coded')).toContain('<string> [pattern /^T-/]');
        expect(argument(foreignHelp.out, 'slug')).toContain(
          '<string> [pattern /^[a-z]+$/, length >=2]',
        );
        expect(argument(foreignHelp.out, 'plain').trimEnd().endsWith('<string>')).toBe(true);
        expect(foreignHelp.out).not.toContain('all of:');
        expect(foreignHelp.out).not.toContain('0-9a-fA-F');
        expect(foreignHelp.out).not.toContain('x-stitchkit');
      } finally {
        await server.stop();
      }
    });
  });

  test('help does not weaken validation for local, contract or runtime calls', async () => {
    const valid = [
      '--score',
      '1',
      '--key',
      'k',
      '--names',
      '["abcdefghijklmnopqrst","abcdefghijklmnopqrst"]',
    ];
    for (const command of ['local', 'search', 'runtime']) {
      const before = calls;
      expect((await run([command, ...valid, '--limit', '50'])).code).toBe(0);
      expect(calls).toBe(before + 1);
      for (const invalid of ['0', '51']) {
        expect((await run([command, ...valid, '--limit', invalid])).code).not.toBe(0);
        expect(calls).toBe(before + 1);
      }
    }
  });
});
