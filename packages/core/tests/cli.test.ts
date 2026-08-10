/**
 * CLI transport — argv parsing + coercion (`cli-args`), command routing, output
 * and exit codes (`cli-format`), `--wait` polling (`cli-wait`), opt-in exposure
 * and the typed `createToolkit` path. Drives `createCli` with injected
 * argv / stdout / stderr / exit so nothing touches the real process.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineContract, notFound } from '../src/contract';
import { isRecord } from '../src/internal/typed';
import { implement } from '../src/server';
import { type CliConfig, createCli } from '../src/tools/cli';
import { CliArgumentError, parseCliArgs } from '../src/tools/cli-args';
import { collectTools } from '../src/tools/mount';
import { createToolkit } from '../src/tools/toolkit';

let jobPolls = 0;

const contract = defineContract(
  { prefix: 'widget', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List widgets',
      toolName: 'list_widgets',
      expose: ['CLI', 'MCP'],
      output: z.object({ items: z.array(z.string()) }),
    },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a widget',
      toolName: 'create_widget',
      expose: ['CLI'],
      input: z.object({
        name: z.string(),
        count: z.number().default(1),
        tags: z.array(z.string()).optional(),
        active: z.boolean().optional(),
      }),
      output: z.object({ id: z.string(), name: z.string(), count: z.number() }),
    },
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get a widget',
      toolName: 'get_widget',
      expose: ['CLI'],
      params: z.strictObject({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.string() }),
    },
    setConfig: {
      method: 'POST',
      path: '/config',
      desc: 'Set config',
      toolName: 'set_config',
      expose: ['CLI'],
      input: z.object({ opts: z.object({ retries: z.number() }) }),
      output: z.object({ ok: z.boolean() }),
    },
    boom: {
      method: 'POST',
      path: '/boom',
      desc: 'Always throws',
      toolName: 'boom_widget',
      expose: ['CLI'],
      output: z.object({ never: z.string() }),
    },
    createJob: {
      method: 'POST',
      path: '/job',
      desc: 'Start a job',
      toolName: 'create_job',
      expose: ['CLI'],
      output: z.object({ id: z.string(), status: z.string() }),
    },
    getJob: {
      method: 'GET',
      path: '/job/:id',
      desc: 'Job status',
      toolName: 'get_job',
      expose: ['CLI'],
      params: z.strictObject({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.string() }),
    },
    internalOnly: {
      method: 'POST',
      path: '/internal',
      desc: 'Not on CLI',
      expose: ['MCP'],
      input: z.object({ x: z.number() }),
    },
    defaultExpose: {
      method: 'POST',
      path: '/def',
      desc: 'Default expose (MCP+AGENT, not CLI)',
      toolName: 'do_default',
      input: z.object({ x: z.number() }),
    },
  },
);

const service = implement(contract, {
  list: () => ({ items: ['a', 'b'] }),
  create: (ctx) => ({ id: 'w1', name: ctx.input.name, count: ctx.input.count }),
  get: (ctx) => ({
    id: ctx.params.id,
    status: ctx.params.id === 'done' ? 'COMPLETED' : 'PENDING',
  }),
  setConfig: (ctx) => ({ ok: ctx.input.opts.retries > 0 }),
  boom: () => notFound('gone'),
  createJob: () => ({ id: 'j1', status: 'PENDING' }),
  getJob: (ctx) => {
    jobPolls += 1;
    return { id: ctx.params.id, status: jobPolls >= 2 ? 'COMPLETED' : 'PENDING' };
  },
  internalOnly: () => undefined,
  defaultExpose: () => undefined,
});

interface RunResult {
  out: string;
  err: string;
  code: number;
}

async function run(argv: string[], cfg: Partial<CliConfig> = {}): Promise<RunResult> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'widget',
    version: '1.0.0',
    services: [service],
    argv,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    exit: (c) => {
      code = c;
    },
    stdin: async () => null,
    ...cfg,
  });
  return { out, err, code };
}

describe('createCli — routing & help', () => {
  test('top-level help lists CLI commands, not MCP-only ones', async () => {
    const { out, code } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('list_widgets');
    expect(out).toContain('create_widget');
    expect(out).toContain('Global options');
    // internalOnly is MCP-only; do_default defaults to MCP+AGENT — neither on CLI.
    expect(out).not.toContain('internalOnly');
    expect(out).not.toContain('do_default');
  });

  test('--version prints name + version', async () => {
    const { out, code } = await run(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toBe('widget 1.0.0');
  });

  test('unknown command → exit 1 on stderr', async () => {
    const { err, code } = await run(['nope']);
    expect(code).toBe(1);
    expect(err).toContain('Unknown command');
  });

  test('command --help shows the flag table', async () => {
    const { out, code } = await run(['create_widget', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--name');
    expect(out).toContain('--count');
    expect(out).toContain('(required)');
  });
});

describe('createCli — execution & coercion', () => {
  test('success → JSON on stdout, exit 0', async () => {
    const { out, code } = await run(['list_widgets', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ items: ['a', 'b'] });
  });

  test('flags coerce to typed values (number, boolean, array)', async () => {
    const { out, code } = await run([
      'create_widget',
      '--name',
      'box',
      '--count',
      '3',
      '--active',
      '--tags',
      'x',
      '--tags',
      'y',
      '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ id: 'w1', name: 'box', count: 3 });
  });

  test('default-valued field is applied when the flag is omitted', async () => {
    const { out } = await run(['create_widget', '--name', 'box', '--json']);
    expect(JSON.parse(out).count).toBe(1);
  });

  test('positional fills the first non-boolean field in declaration order', async () => {
    const { out } = await run(['create_widget', 'box', '--json']);
    expect(JSON.parse(out).name).toBe('box');
  });

  test('path param via flag', async () => {
    const { out } = await run(['get_widget', '--id', 'done', '--json']);
    expect(JSON.parse(out).status).toBe('COMPLETED');
  });

  test('nested object via JSON-string flag (coerceJson)', async () => {
    const { out, code } = await run(['set_config', '--opts', '{"retries":3}', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  test('missing required field → VALIDATION_ERROR, exit 1', async () => {
    const { err, code } = await run(['create_widget', '--count', '3', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(err).error).toBe('VALIDATION_ERROR');
  });

  test('handler error maps the code to its exit code (NOT_FOUND → 4)', async () => {
    const { err, code } = await run(['boom_widget']);
    expect(code).toBe(4);
    expect(JSON.parse(err).error).toBe('NOT_FOUND');
  });

  test('custom exitCodes override the default', async () => {
    const { code } = await run(['boom_widget'], { exitCodes: { NOT_FOUND: 42 } });
    expect(code).toBe(42);
  });

  test('--dry-run prints the resolved call without executing', async () => {
    const { out, code } = await run(['create_widget', '--name', 'box', '--dry-run']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('create_widget');
    expect(parsed.args.name).toBe('box');
  });
});

describe('createCli — --wait polling', () => {
  test('polls a tool until done', async () => {
    jobPolls = 0;
    const { out, code } = await run(['create_job', '--wait', '--quiet', '--json'], {
      wait: {
        create_job: {
          tool: 'get_job',
          poll: (r) => (isRecord(r) && typeof r.id === 'string' ? { id: r.id } : null),
          done: (r) => isRecord(r) && r.status === 'COMPLETED',
          backoff: [0],
        },
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).status).toBe('COMPLETED');
  });
});

describe('createCli — --output-dir download', () => {
  test('downloads via the guarded fetcher and contains the filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sk-cli-dl-'));
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    try {
      const { code } = await run(['list_widgets', '--output-dir', dir, '--quiet'], {
        // A public IP literal skips DNS in the SSRF guard; the name carries a
        // traversal attempt that basename-containment must neutralise.
        download: () => [{ url: 'https://93.184.216.34/a.png', name: '../escaped.png' }],
      });
      expect(code).toBe(0);
      const files = await readdir(dir);
      expect(files).toEqual(['escaped.png']); // `../` stripped — stays inside dir
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createCli — opt-in exposure', () => {
  test('only methods with CLI in expose become commands', () => {
    const names = collectTools(service, 'CLI').map((t) => t.name);
    expect(names).toContain('list_widgets');
    expect(names).toContain('create_widget');
    expect(names).not.toContain('do_default'); // default expose = MCP+AGENT
  });
});

describe('createToolkit — typed context path runs', () => {
  test('toolkit.createCli executes with a typed context factory', async () => {
    const toolkit = createToolkit<{ requestId: string }>();
    let out = '';
    let code = -1;
    await toolkit.createCli({
      name: 'widget',
      version: '1.0.0',
      services: [service],
      context: () => ({ requestId: 'r1' }),
      argv: ['list_widgets', '--json'],
      stdout: (t) => {
        out += t;
      },
      stderr: () => undefined,
      exit: (c) => {
        code = c;
      },
      stdin: async () => null,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).items).toEqual(['a', 'b']);
  });
});

describe('parseCliArgs — unit', () => {
  const schema = z.object({
    name: z.string(),
    count: z.number(),
    active: z.boolean(),
    tags: z.array(z.string()),
    nested: z.object({ a: z.string() }),
    cfg: z.record(z.string(), z.unknown()).optional(),
  });

  test('lifts reserved options out of tool args', () => {
    const { options, toolArgs } = parseCliArgs(
      ['--json', '--wait', '--wait-timeout', '30', '--name', 'x'],
      schema,
    );
    expect(options.json).toBe(true);
    expect(options.wait).toBe(true);
    expect(options.waitTimeout).toBe(30);
    expect(toolArgs).toEqual({ name: 'x' });
  });

  test('coerces number, boolean presence and repeated array flags', () => {
    const { toolArgs } = parseCliArgs(
      ['--count', '5', '--active', '--tags', 'a', '--tags', 'b'],
      schema,
    );
    expect(toolArgs.count).toBe(5);
    expect(toolArgs.active).toBe(true);
    expect(toolArgs.tags).toEqual(['a', 'b']);
  });

  test('--no-flag negates a boolean', () => {
    const { toolArgs } = parseCliArgs(['--no-active'], schema);
    expect(toolArgs.active).toBe(false);
  });

  test('dotted path builds a nested object with a loose-coerced leaf', () => {
    const { toolArgs } = parseCliArgs(['--nested.a', 'hello'], schema);
    expect(toolArgs.nested).toEqual({ a: 'hello' });
  });

  test('a single JSON object string is left raw for coerceJson', () => {
    const { toolArgs } = parseCliArgs(['--nested', '{"a":"b"}'], schema);
    expect(toolArgs.nested).toBe('{"a":"b"}');
  });

  test('a dotted __proto__ path is refused LOUDLY and does not pollute Object.prototype', () => {
    try {
      // A silently dropped argument reads as data loss — the unsafe path is a
      // usage error, not a no-op.
      expect(() => parseCliArgs(['--cfg.__proto__.polluted=yes'], schema)).toThrow(
        CliArgumentError,
      );
      expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
    } finally {
      // A pre-fix run would have left this on the prototype — scrub it so a
      // failure here cannot leak into the rest of the suite.
      Reflect.deleteProperty(Object.prototype, 'polluted');
    }
  });

  test('a dotted constructor path is a normal own-key write (not blocked)', () => {
    // `constructor` as a plain own key is inert — only `__proto__` is stripped.
    const { toolArgs } = parseCliArgs(['--cfg.constructor.x=1'], schema);
    expect(isRecord(toolArgs.cfg)).toBe(true);
    if (isRecord(toolArgs.cfg)) expect(isRecord(toolArgs.cfg.constructor)).toBe(true);
  });

  test('a top-level --__proto__ flag is a loud usage error, not a silent drop', () => {
    expect(() => parseCliArgs(['--__proto__', 'x'], schema)).toThrow(/Unsafe option/);
  });

  test('a reserved boolean rejects an unrecognised value instead of enabling silently', () => {
    expect(() => parseCliArgs(['--json=banana'], schema)).toThrow(/expects a boolean/);
    expect(parseCliArgs(['--json=false'], schema).options.json).toBe(false);
  });

  test('a repeated scalar flag is an error, not a silent last-wins', () => {
    expect(() => parseCliArgs(['--name', 'a', '--name', 'b'], schema)).toThrow(
      /passed 2 times/,
    );
    expect(() => parseCliArgs(['--nested.a', '1', '--nested.a', '2'], schema)).toThrow(
      /passed 2 times/,
    );
  });

  test('a plain flag and a dotted flag over the same root conflict in BOTH orders', () => {
    // Regression: whichever ran last silently destroyed the other, so the
    // result depended on argument order at exit code 0.
    for (const argv of [
      ['--nested', '{"keep":1}', '--nested.a', '2'],
      ['--nested.a', '2', '--nested', '{"keep":1}'],
    ]) {
      expect(() => parseCliArgs(argv, schema)).toThrow(/conflicts with/);
    }
  });

  test('a negative number is accepted as a space-form value', () => {
    const { toolArgs } = parseCliArgs(['--count', '-5'], schema);
    expect(toolArgs.count).toBe(-5);
  });

  test('an unrecognisable boolean field value is left raw for Zod, not coerced to true', () => {
    const { toolArgs } = parseCliArgs(['--active=banana'], schema);
    expect(toolArgs.active).toBe('banana');
  });

  test('a union schema exposes the boolean member as a flag and keeps positionals in place', () => {
    const unionSchema = z.union([
      z.object({ verbose: z.boolean() }),
      z.object({ q: z.string() }),
    ]);
    const { toolArgs } = parseCliArgs(['--verbose', 'hello'], unionSchema);
    expect(toolArgs.verbose).toBe(true);
    // `hello` fills the non-boolean member field instead of being shifted/lost.
    expect(toolArgs.q).toBe('hello');
  });
});

describe('createCli — reserved names on intersection schemas', () => {
  test('a params+scalar-input command (allOf schema) still trips the reserved-name guard', async () => {
    // `params` + a non-object `input` publish as `allOf: [...]` — the guard
    // must see through the intersection, not go blind on it.
    const jobs = defineContract(
      { prefix: 'jobs', scope: 'public' },
      {
        schedule: {
          method: 'POST',
          path: '/:wait',
          desc: 'Schedule a job',
          toolName: 'schedule_job',
          expose: ['CLI'],
          params: z.strictObject({ wait: z.string() }),
          input: z.string(),
        },
      },
    );
    const jobsService = implement(jobs, { schedule: () => undefined });
    await expect(run(['schedule_job', '--help'], { services: [jobsService] })).rejects.toThrow(
      /reserved option field/,
    );
  });

  test('an intersection command shows a real Arguments section in --help', async () => {
    const jobs = defineContract(
      { prefix: 'jobs', scope: 'public' },
      {
        schedule: {
          method: 'POST',
          path: '/:slot',
          desc: 'Schedule a job',
          toolName: 'schedule_job',
          expose: ['CLI'],
          params: z.strictObject({ slot: z.string() }),
          input: z.string(),
        },
      },
    );
    const jobsService = implement(jobs, { schedule: () => undefined });
    const { out, code } = await run(['schedule_job', '--help'], { services: [jobsService] });
    expect(code).toBe(0);
    expect(out).toContain('--slot');
  });
});

describe('createCli — --help beats option validators', () => {
  test('a mistyped flag next to --help still prints the flag table', async () => {
    const { out, code } = await run(['create_widget', '--tyop', 'x', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--name');
    expect(out).toContain('--count');
  });
});

describe('createCli — passthrough', () => {
  test('flat flags merge into a JSON object field instead of clobbering it', async () => {
    const { out, code } = await run(
      ['set_config', '--opts', '{"retries":3}', '--extra', 'foo', '--dry-run'],
      { passthrough: { set_config: 'opts' } },
    );
    expect(code).toBe(0);
    // The `--opts` JSON survives — the passthrough bag merges onto it.
    expect(JSON.parse(out).args.opts).toEqual({ retries: 3, extra: 'foo' });
  });

  test('with no JSON field the passthrough bag becomes the object', async () => {
    const { out } = await run(['set_config', '--retries', '5', '--dry-run'], {
      passthrough: { set_config: 'opts' },
    });
    expect(JSON.parse(out).args.opts).toEqual({ retries: 5 });
  });
});
