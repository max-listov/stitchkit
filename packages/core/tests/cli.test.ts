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
import { defineCliCommand } from '../src/tools/cli-command';
import { pollUntilDone } from '../src/tools/cli-wait';
import type { ToolResult } from '../src/tools/execute';
import { listToolNames } from '../src/tools/list-names';
import { collectTools } from '../src/tools/mount';
import { defineRuntimeTool } from '../src/tools/runtime-tool';
import { createToolkit } from '../src/tools/toolkit';
import { summarizeTransports } from '../src/tools/transports';

let jobPolls = 0;
let jobTerminalStatus = 'COMPLETED';

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
    return { id: ctx.params.id, status: jobPolls >= 2 ? jobTerminalStatus : 'PENDING' };
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
    expect(out).toContain('Usage: widget create_widget <name> [count] [tags] [--flags]');
    expect(out).toContain('<name> | --name');
    expect(out).not.toContain('[active]');
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
    const error = JSON.parse(err);
    expect(error.error).toBe('VALIDATION_ERROR');
    expect(err).toBe(`${JSON.stringify(error)}\n`);
  });

  test('without --json a structured failure remains pretty-printed on stderr', async () => {
    const { err, code } = await run(['create_widget', '--count', '3']);
    expect(code).toBe(1);
    const error = JSON.parse(err);
    expect(err).toBe(`${JSON.stringify(error, null, 2)}\n`);
  });

  test('piped stdin fills an unset REQUIRED field', async () => {
    const { out, code } = await run(['create_widget', '--json'], {
      stdin: async () => 'piped-box',
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).name).toBe('piped-box');
  });

  test('without positional policy stdin keeps the historical raw-string behavior', async () => {
    const numeric = defineCliCommand({
      name: 'numeric_stdin',
      description: 'No-policy stdin compatibility probe',
      input: z.object({ count: z.number() }),
      output: z.object({ count: z.number() }),
      handler: ({ input }) => input,
    });
    const result = await run(['numeric_stdin', '--json'], {
      commands: [numeric],
      stdin: async () => '3',
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err).error).toBe('VALIDATION_ERROR');
  });

  test('stdin is never read when every unset field is optional', async () => {
    // In an agent's shell stdin is an open pipe with no EOF — a read for an
    // optional field would hang the command forever. The reader must not run.
    let stdinReads = 0;
    const { out, code } = await run(['create_widget', '--name', 'box', '--json'], {
      stdin: async () => {
        stdinReads += 1;
        return 'must-not-be-consumed';
      },
    });
    expect(code).toBe(0);
    expect(stdinReads).toBe(0);
    expect(JSON.parse(out).name).toBe('box');

    // A command with no input fields at all does not read stdin either.
    stdinReads = 0;
    const list = await run(['list_widgets', '--json'], {
      stdin: async () => {
        stdinReads += 1;
        return 'ignored';
      },
    });
    expect(list.code).toBe(0);
    expect(stdinReads).toBe(0);
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
    jobTerminalStatus = 'COMPLETED';
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

  test('terminal domain failure becomes WAIT_FAILED with a non-zero exit', async () => {
    jobPolls = 0;
    jobTerminalStatus = 'FAILED';
    const { out, err, code } = await run(['create_job', '--wait', '--quiet', '--json'], {
      wait: {
        create_job: {
          tool: 'get_job',
          poll: (r) => (isRecord(r) && typeof r.id === 'string' ? { id: r.id } : null),
          done: (r) => isRecord(r) && ['COMPLETED', 'FAILED'].includes(String(r.status)),
          failed: (r) => isRecord(r) && r.status === 'FAILED',
          backoff: [0],
        },
      },
    });

    expect(code).toBe(1);
    expect(out).toBe('');
    expect(JSON.parse(err)).toEqual({
      error: 'WAIT_FAILED',
      details: {
        message: '"get_job" reached a terminal failed state',
        result: { id: 'j1', status: 'FAILED' },
      },
    });
  });

  test('failed is checked on the initial result and takes priority over done', async () => {
    let polls = 0;
    const result = await pollUntilDone({
      initial: { ok: true, data: { id: 'j1', status: 'FAILED' } },
      wait: {
        tool: 'get_job',
        poll: () => ({ id: 'j1' }),
        done: () => true,
        failed: (value) => isRecord(value) && value.status === 'FAILED',
      },
      call: async () => {
        polls += 1;
        return { ok: true, data: { status: 'COMPLETED' } };
      },
    });

    expect(polls).toBe(0);
    expect(result).toEqual({
      ok: false,
      code: 'WAIT_FAILED',
      details: {
        message: '"get_job" reached a terminal failed state',
        result: { id: 'j1', status: 'FAILED' },
      },
    });
  });

  test('a failed poll call keeps its transport error instead of becoming WAIT_FAILED', async () => {
    const transportFailure = {
      ok: false,
      code: 'UNAUTHORIZED',
      details: { message: 'expired' },
    } satisfies ToolResult;
    const result = await pollUntilDone({
      initial: { ok: true, data: { id: 'j1', status: 'PENDING' } },
      wait: {
        tool: 'get_job',
        poll: () => ({ id: 'j1' }),
        done: () => false,
        failed: (value) => isRecord(value) && value.status === 'FAILED',
        backoff: [0],
      },
      call: async () => transportFailure,
    });

    expect(result).toBe(transportFailure);
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

describe('createCli — pathless runtime tools', () => {
  test('an explicit CLI definition shares help, validation, lifecycle and hooks', async () => {
    const phases: string[] = [];
    const definition = defineRuntimeTool({
      name: 'inspect_local',
      description: 'Inspect a local value',
      identity: { serviceName: 'local', action: 'inspect', method: 'GET' },
      input: z.object({ path: z.string() }),
      output: z.object({ path: z.string(), source: z.literal('cli') }),
      transports: ['CLI'],
      handler: ({ input, source }): { path: string; source: 'cli' } => {
        expect(source).toBe('cli');
        return { path: input.path, source: 'cli' };
      },
    });
    expect(listToolNames({ runtimeTools: [definition] })).toEqual([
      {
        kind: 'runtime',
        name: 'inspect_local',
        service: 'local',
        method: 'inspect',
        transports: ['CLI'],
      },
    ]);
    expect(summarizeTransports({ runtimeTools: [definition] }).totals.CLI).toBe(1);
    const help = await run(['--help'], { runtimeTools: [definition] });
    expect(help.out).toContain('inspect_local');

    const called = await run(['inspect_local', '--path', './asset.png', '--json'], {
      runtimeTools: [definition],
      lifecycle: {
        beforeHandle: (_context, endpoint) => {
          phases.push(`lifecycle:${endpoint.serviceName}:${endpoint.key}`);
        },
      },
      hooks: {
        afterToolCall: ({ result }) => {
          phases.push(`hook:${result.ok}`);
        },
      },
    });
    expect(called.code).toBe(0);
    expect(JSON.parse(called.out)).toEqual({ path: './asset.png', source: 'cli' });
    expect(phases).toEqual(['lifecycle:local:inspect', 'hook:true']);
  });

  test('undefined exposure stays MCP+Agent-only and a runtime-only CLI works', async () => {
    const hidden = defineRuntimeTool({
      name: 'hidden_runtime',
      description: 'Not a CLI command by default',
      identity: { serviceName: 'local', action: 'hidden', method: 'GET' },
      input: z.object({}),
      handler: () => undefined,
    });
    const visible = defineRuntimeTool({
      name: 'runtime_only',
      description: 'Runtime-only CLI',
      identity: { serviceName: 'local', action: 'only', method: 'GET' },
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      transports: ['CLI'],
      handler: ({ input }) => input,
    });
    const result = await run(['runtime_only', 'yes', '--json'], {
      services: [],
      runtimeTools: [hidden, visible],
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ value: 'yes' });
    const help = await run(['--help'], {
      services: [],
      runtimeTools: [hidden, visible],
    });
    expect(help.out).toContain('runtime_only');
    expect(help.out).not.toContain('hidden_runtime');
  });

  test('a contract/runtime collision fails before dispatch', async () => {
    const collision = defineRuntimeTool({
      name: 'list_widgets',
      description: 'Collision',
      identity: { serviceName: 'runtime', action: 'list', method: 'GET' },
      input: z.object({}),
      transports: ['CLI'],
      handler: () => undefined,
    });
    await expect(run(['list_widgets'], { runtimeTools: [collision] })).rejects.toThrow(
      'Duplicate CLI command "list_widgets" across mounted operations',
    );
  });
});

describe('createCli — native command composition', () => {
  const doctor = defineCliCommand({
    name: 'doctor',
    description: 'Inspect this executable',
    input: z.object({ target: z.string(), verbose: z.boolean().default(false) }),
    output: z.object({ target: z.string(), verbose: z.boolean() }),
    handler: ({ input, options, stderr }) => {
      if (!options.quiet) stderr('checking\n');
      return input;
    },
  });

  test('lists, documents, validates and emits one typed native command', async () => {
    const top = await run(['--help'], { commands: [doctor] });
    expect(top.out).toContain('doctor');
    expect(top.out).toContain('list_widgets');

    const help = await run(['doctor', '--help', '--mistyped'], { commands: [doctor] });
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: widget doctor <target> [--flags]');
    expect(help.out).toContain('<target> | --target');
    expect(help.out).not.toContain('[verbose]');
    expect(help.out).toContain('--target');

    const called = await run(['doctor', 'runtime', '--verbose', '--json'], {
      commands: [doctor],
    });
    expect(called.code).toBe(0);
    expect(JSON.parse(called.out)).toEqual({ target: 'runtime', verbose: true });
    expect(called.err).toBe('checking\n');

    const invalid = await run(['doctor'], { commands: [doctor] });
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.err).error).toBe('VALIDATION_ERROR');
  });

  test('dispatches native commands before auth, services, context and runtime factories', async () => {
    const calls: string[] = [];
    const result = await run(['doctor', 'local', '--quiet', '--json'], {
      commands: [doctor],
      services: () => {
        calls.push('services');
        return [service];
      },
      runtimeTools: () => {
        calls.push('runtimeTools');
        return [];
      },
      resolveAuth: () => {
        calls.push('auth');
        return { userId: 'u1' };
      },
      context: () => {
        calls.push('context');
        return {};
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).target).toBe('local');
    expect(calls).toEqual([]);
  });

  test('version and static top-level help stay credential-free', async () => {
    let authCalls = 0;
    const config = {
      commands: [doctor],
      resolveAuth: () => {
        authCalls += 1;
        return { userId: 'u1' };
      },
    };

    const version = await run(['--version'], config);
    expect(version.code).toBe(0);
    expect(version.out).toContain('widget 1.0.0');

    const help = await run(['--help'], config);
    expect(help.code).toBe(0);
    expect(help.out).toContain('doctor');
    expect(authCalls).toBe(0);
  });

  test('maps a native throw and rejects cross-source name collisions', async () => {
    const failing = defineCliCommand({
      name: 'native_fail',
      description: 'Fail locally',
      input: z.object({}),
      handler: () => notFound('missing local state'),
    });
    const failed = await run(['native_fail'], { commands: [failing] });
    expect(failed.code).toBe(4);
    expect(JSON.parse(failed.err).error).toBe('NOT_FOUND');

    const collision = defineCliCommand({
      name: 'list_widgets',
      description: 'Collision',
      input: z.object({}),
      handler: () => undefined,
    });
    await expect(run(['--help'], { commands: [collision] })).rejects.toThrow(
      'Duplicate CLI command "list_widgets" across mounted operations',
    );
  });
});

describe('createCli — declarative command presentation policy', () => {
  const logs = defineCliCommand({
    name: 'logs',
    description: 'Read service logs',
    input: z.object({
      target: z.string().default('all'),
      follow: z.boolean().default(false),
      lines: z.number().default(100),
      tags: z.array(z.string()).default([]),
    }),
    output: z.object({
      target: z.string(),
      follow: z.boolean(),
      lines: z.number(),
      tags: z.array(z.string()),
    }),
    handler: ({ input }) => input,
  });

  const presentation = {
    commands: [logs],
    defaultCommand: 'logs',
    optionAliases: { logs: { f: 'follow', n: 'lines', t: 'tags' } },
    positionals: { logs: ['target'] },
  } satisfies Partial<CliConfig>;

  test('default command composes with global-only argv and explicit routing', async () => {
    const bare = await run([], presentation);
    expect(bare.code).toBe(0);
    expect(JSON.parse(bare.out)).toEqual({
      target: 'all',
      follow: false,
      lines: 100,
      tags: [],
    });

    const globalOnly = await run(['--json', '-f'], presentation);
    expect(globalOnly.code).toBe(0);
    expect(JSON.parse(globalOnly.out).follow).toBe(true);

    const explicit = await run(['--json', 'logs', 'api', '-n=25'], presentation);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.out)).toMatchObject({ target: 'api', lines: 25 });

    const typo = await run(['--json', 'logz'], presentation);
    expect(typo.code).toBe(1);
    expect(typo.err).toContain('Unknown command "logz"');

    for (const argv of [
      ['--wait-timeout', '30', 'logs', '--help'],
      ['--output-dir=./out', 'logs', '--help'],
    ]) {
      const prefixed = await run(argv, presentation);
      expect(prefixed.code).toBe(0);
      expect(prefixed.out).toContain('Usage: widget logs');
    }
    const defaultWithValueGlobal = await run(['--output-dir=./out'], presentation);
    expect(defaultWithValueGlobal.code).toBe(2);
    expect(defaultWithValueGlobal.err).toContain('not configured for native commands');
  });

  test('default command preserves top-level help/version precedence without dispatch', async () => {
    let calls = 0;
    const counted = defineCliCommand({
      name: 'counted',
      description: 'Count dispatches',
      input: z.object({}),
      output: z.object({ calls: z.number() }),
      handler: () => ({ calls: ++calls }),
    });
    const config = { commands: [counted], defaultCommand: 'counted' };

    for (const argv of [
      ['--help'],
      ['-h'],
      ['--json', '--help'],
      ['--json=invalid', '--help'],
      ['--output-dir', '--help'],
    ]) {
      const result = await run(argv, config);
      expect(result.code).toBe(0);
      expect(result.out).toContain('Usage: widget [command]');
      expect(result.out).toContain('Count dispatches (default)');
    }
    const version = await run(['--json', '--version'], config);
    expect(version).toEqual({ out: 'widget 1.0.0\n', err: '', code: 0 });
    expect(calls).toBe(0);
    const surfaceFreeVersion = await run(['--version'], { defaultCommand: 'missing' });
    expect(surfaceFreeVersion).toEqual({ out: 'widget 1.0.0\n', err: '', code: 0 });

    const falseHelp = await run(['--help=false', '--json'], config);
    expect(falseHelp.code).toBe(0);
    expect(JSON.parse(falseHelp.out).calls).toBe(1);

    const separator = await run(['--'], config);
    expect(separator.code).toBe(2);
    expect(separator.err).toContain('A command is required before "--"');
    const afterSeparator = await run(['--json', '--', '--help'], config);
    expect(afterSeparator.code).toBe(2);
    expect(afterSeparator.out).toBe('');
  });

  test('native default remains credential-free beside dynamic managed surfaces', async () => {
    const calls: string[] = [];
    const result = await run(['--json'], {
      ...presentation,
      services: () => {
        calls.push('services');
        return [service];
      },
      runtimeTools: () => {
        calls.push('runtimeTools');
        return [];
      },
      resolveAuth: () => {
        calls.push('auth');
        return { userId: 'u1' };
      },
    });
    expect(result.code).toBe(0);
    expect(calls).toEqual([]);
  });

  test('managed commands accept aliases and explicit positionals after surface resolution', async () => {
    const result = await run(['create_widget', 'alpha', '-n', '3', '--json'], {
      optionAliases: { create_widget: { n: 'count' } },
      positionals: { create_widget: ['name'] },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ id: 'w1', name: 'alpha', count: 3 });

    const defaultManaged = await run(['--json'], { defaultCommand: 'list_widgets' });
    expect(defaultManaged.code).toBe(0);
    expect(JSON.parse(defaultManaged.out).items).toEqual(['a', 'b']);

    const runtime = defineRuntimeTool({
      name: 'runtime_policy',
      description: 'Exercise resolved runtime CLI policy',
      identity: { serviceName: 'runtime', action: 'policy', method: 'POST' },
      input: z.object({ target: z.string(), verbose: z.boolean().default(false) }),
      output: z.object({ target: z.string(), verbose: z.boolean() }),
      transports: ['CLI'],
      handler: ({ input }) => input,
    });
    const runtimeResult = await run(['-v', '--target', 'packed', '--json'], {
      services: [],
      runtimeTools: [runtime],
      defaultCommand: 'runtime_policy',
      optionAliases: { runtime_policy: { v: 'verbose' } },
      positionals: { runtime_policy: ['target'] },
    });
    expect(runtimeResult.code).toBe(0);
    expect(JSON.parse(runtimeResult.out)).toEqual({ target: 'packed', verbose: true });
  });

  test('dynamic managed policy resolves identity, factories, context and lifecycle once', async () => {
    const phases: string[] = [];
    const dynamic = defineRuntimeTool({
      name: 'dynamic_policy',
      description: 'Identity-dependent CLI policy probe',
      identity: { serviceName: 'dynamic', action: 'policy', method: 'POST' },
      input: z.object({ target: z.string(), verbose: z.boolean().default(false) }),
      output: z.object({ target: z.string(), verbose: z.boolean() }),
      transports: ['CLI'],
      handler: ({ input }) => {
        phases.push('handler');
        return input;
      },
    });
    const result = await run(['--target', 'packed', '-v', '--json'], {
      defaultCommand: 'dynamic_policy',
      optionAliases: { dynamic_policy: { v: 'verbose' } },
      positionals: { dynamic_policy: ['target'] },
      resolveAuth: () => {
        phases.push('auth');
        return { userId: 'u1' };
      },
      services: () => {
        phases.push('services');
        return [];
      },
      runtimeTools: () => {
        phases.push('runtimeTools');
        return [dynamic];
      },
      context: () => {
        phases.push('context');
        return { requestId: 'r1' };
      },
      lifecycle: {
        beforeHandle: () => {
          phases.push('lifecycle');
        },
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ target: 'packed', verbose: true });
    expect(phases).toEqual([
      'auth',
      'services',
      'runtimeTools',
      'context',
      'lifecycle',
      'handler',
    ]);

    await expect(
      run(['--json'], {
        defaultCommand: 'identity_missing',
        resolveAuth: () => ({ userId: 'u1' }),
        services: () => [],
      }),
    ).rejects.toThrow('targets unavailable command "identity_missing"');
  });

  test('short aliases share canonical duplicate and coercion rules', async () => {
    const result = await run(
      ['logs', 'api', '-f=false', '-n', '25', '-t', 'one', '--tags', 'two', '--json'],
      presentation,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      target: 'api',
      follow: false,
      lines: 25,
      tags: ['one', 'two'],
    });

    const duplicate = await run(['logs', '-n', '2', '--lines', '3'], presentation);
    expect(duplicate.code).toBe(2);
    expect(duplicate.err).toContain('--lines was passed 2 times');

    const unknown = await run(['-z'], presentation);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown option "-z"');
    for (const argv of [
      ['logs', '-fn'],
      ['logs', '-n100'],
      ['logs', '-n'],
      ['logs', '--no-f'],
    ]) {
      const invalid = await run(argv, presentation);
      expect(invalid.code).toBe(2);
    }

    const structured = defineCliCommand({
      name: 'structured_alias',
      description: 'Structured alias coercion probe',
      input: z.object({
        mode: z.enum(['fast', 'safe']),
        config: z.object({ retries: z.number() }),
      }),
      output: z.object({ mode: z.enum(['fast', 'safe']), retries: z.number() }),
      handler: ({ input }) => ({ mode: input.mode, retries: input.config.retries }),
    });
    const structuredResult = await run(
      ['structured_alias', '-m', 'fast', '-c', '{"retries":2}', '--json'],
      {
        commands: [structured],
        optionAliases: { structured_alias: { m: 'mode', c: 'config' } },
      },
    );
    expect(structuredResult.code).toBe(0);
    expect(JSON.parse(structuredResult.out)).toEqual({ mode: 'fast', retries: 2 });
    const leaked = await run(['logs', '-m', 'fast'], {
      ...presentation,
      commands: [logs, structured],
      optionAliases: { structured_alias: { m: 'mode' } },
    });
    expect(leaked.code).toBe(2);
    expect(leaked.err).toContain('Unknown option "-m"');
  });

  test('explicit positionals leave option-only fields to flags and stdin', async () => {
    const strictLogs = defineCliCommand({
      name: 'strict_logs',
      description: 'Read a bounded log stream',
      input: z.object({ target: z.string(), lines: z.number() }),
      output: z.object({ target: z.string(), lines: z.number() }),
      handler: ({ input }) => input,
    });
    const config = {
      commands: [strictLogs],
      positionals: { strict_logs: ['target'] },
      stdin: async () => '40',
    };
    const result = await run(['strict_logs', 'api', '--json'], config);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ target: 'api', lines: 40 });

    const extra = await run(['strict_logs', 'api', '40'], config);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('Unexpected positional argument "40"');

    const noPositionals = await run(['strict_logs', '--target', 'api', '--json'], {
      ...config,
      positionals: { strict_logs: [] },
    });
    expect(noPositionals.code).toBe(0);
    expect(JSON.parse(noPositionals.out)).toEqual({ target: 'api', lines: 40 });

    const OrderedOutput = z.object({
      first: z.string(),
      count: z.number(),
      tags: z.array(z.string()),
      meta: z.object({ retries: z.number() }),
    });
    const ordered = defineCliCommand({
      name: 'ordered_values',
      description: 'Several explicit positional values',
      input: OrderedOutput,
      output: OrderedOutput,
      handler: ({ input }) => input,
    });
    const orderedResult = await run(
      ['ordered_values', '--first', 'fixed', '12', '["one","two"]', '{"retries":3}', '--json'],
      {
        commands: [ordered],
        positionals: { ordered_values: ['first', 'count', 'tags', 'meta'] },
      },
    );
    expect(orderedResult.code).toBe(0);
    expect(JSON.parse(orderedResult.out)).toEqual({
      first: 'fixed',
      count: 12,
      tags: ['one', 'two'],
      meta: { retries: 3 },
    });
  });

  test('command help reflects the exact aliases and positional policy', async () => {
    const help = await run(['logs', '--help', '-z'], presentation);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: widget logs [target] [--flags]');
    expect(help.out).toContain('-n, --lines');
    expect(help.out).toContain('-f, --follow');
    expect(help.out).not.toContain('[lines]');

    const noPositionals = await run(['logs', 'api'], {
      ...presentation,
      positionals: { logs: [] },
    });
    expect(noPositionals.code).toBe(2);
    expect(noPositionals.err).toContain('Unexpected positional argument "api"');
  });

  test('invalid command-scoped policies fail at the resolved surface boundary', async () => {
    await expect(
      run(['logs'], { commands: [logs], optionAliases: { logs: { h: 'follow' } } }),
    ).rejects.toThrow('alias "-h" is reserved');
    await expect(
      run(['logs'], { commands: [logs], optionAliases: { logs: { 1: 'follow' } } }),
    ).rejects.toThrow('must be one ASCII letter');
    await expect(
      run(['logs'], {
        commands: [logs],
        optionAliases: { logs: { f: 'follow', F: 'follow' } },
      }),
    ).rejects.toThrow('has multiple aliases');
    await expect(
      run(['list_widgets'], {
        commands: [logs],
        optionAliases: { missing: { f: 'follow' } },
      }),
    ).rejects.toThrow('targets unavailable command "missing"');
    await expect(
      run(['logs'], { commands: [logs], positionals: { logs: ['follow'] } }),
    ).rejects.toThrow('boolean field "follow" cannot be positional');
    await expect(
      run(['logs'], { commands: [logs], positionals: { logs: ['target', 'target'] } }),
    ).rejects.toThrow('repeats positional field "target"');
    await expect(
      run(['logs'], { commands: [logs], positionals: { logs: ['missing'] } }),
    ).rejects.toThrow('positional targets unknown field "missing"');
    await expect(
      run(['logs'], {
        commands: [logs],
        optionAliases: { logs: { t: 'tags' } },
        passthrough: { logs: 'tags' },
      }),
    ).rejects.toThrow('cannot alias passthrough field "tags"');

    const optionalFirst = defineCliCommand({
      name: 'ordered',
      description: 'Invalid positional ordering probe',
      input: z.object({ optional: z.string().optional(), required: z.string() }),
      handler: () => undefined,
    });
    await expect(
      run(['ordered'], {
        commands: [optionalFirst],
        positionals: { ordered: ['optional', 'required'] },
      }),
    ).rejects.toThrow('required positional "required" cannot follow an optional positional');

    for (const name of ['constructor', '__proto__']) {
      const inheritedName = defineCliCommand({
        name,
        description: 'Prototype-sensitive policy lookup probe',
        input: z.object({ value: z.string().default('ok') }),
        output: z.object({ value: z.string() }),
        handler: ({ input }) => input,
      });
      const result = await run([name, '--json'], {
        commands: [inheritedName],
        optionAliases: {},
        positionals: {},
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).value).toBe('ok');
    }
  });
});

describe('createCli — native result presentation and exit policy', () => {
  const StatusOutput = z.object({ status: z.enum(['ok', 'degraded']), checks: z.number() });
  const status = defineCliCommand({
    name: 'status',
    description: 'Show native health',
    input: z.object({ degraded: z.boolean().default(false) }),
    output: StatusOutput,
    handler: ({ input }) =>
      StatusOutput.parse({ status: input.degraded ? 'degraded' : 'ok', checks: 3 }),
    present: ({ result, options }) => {
      if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
        // @ts-expect-error presenter inference is the exact declared Zod output.
        void result.missing;
      }
      return options.json
        ? `${JSON.stringify(result)}\n`
        : `STATUS ${result.status} (${result.checks})\n`;
    },
    exitCode: (result) => (result.status === 'degraded' ? 1 : 0),
  });

  test('validated native output can render exact bytes and classify successful exit', async () => {
    const degraded = await run(['status', '--degraded'], { commands: [status] });
    expect(degraded).toEqual({ out: 'STATUS degraded (3)\n', err: '', code: 1 });

    const json = await run(['status', '--json'], { commands: [status] });
    expect(json).toEqual({ out: '{"status":"ok","checks":3}\n', err: '', code: 0 });
  });

  test('exit policy without a presenter retains canonical JSON output', async () => {
    const ClassifiedOutput = z.object({ state: z.literal('partial') });
    const classified = defineCliCommand({
      name: 'classified',
      description: 'Classify a valid result',
      input: z.object({}),
      output: ClassifiedOutput,
      handler: () => ClassifiedOutput.parse({ state: 'partial' }),
      exitCode: () => 7,
    });
    const result = await run(['classified', '--json'], { commands: [classified] });
    expect(JSON.parse(result.out)).toEqual({ state: 'partial' });
    expect(result.code).toBe(7);
  });

  test('policy callbacks never run for help, dry-run or failed output validation', async () => {
    let calls = 0;
    const guarded = defineCliCommand({
      name: 'guarded_policy',
      description: 'Guard policy phases',
      input: z.object({}),
      output: z.object({ value: z.number() }),
      handler: () => ({ value: 1 }),
      present: ({ result }) => {
        calls += result.value;
        return 'done\n';
      },
      exitCode: () => {
        calls += 1;
        return 0;
      },
    });
    await run(['guarded_policy', '--help'], { commands: [guarded] });
    await run(['guarded_policy', '--dry-run'], { commands: [guarded] });
    expect(calls).toBe(0);

    Reflect.set(guarded, 'handler', () => ({ value: 'wrong' }));
    const invalid = await run(['guarded_policy'], { commands: [guarded] });
    expect(invalid.code).toBe(1);
    expect(calls).toBe(0);
  });

  test('throwing or invalid result policy becomes a normalized internal failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const ValidOutput = z.object({ ok: z.literal(true) });
    const invalidExit = defineCliCommand({
      name: 'invalid_exit',
      description: 'Return an invalid process status',
      input: z.object({}),
      output: ValidOutput,
      handler: () => ValidOutput.parse({ ok: true }),
      exitCode: () => 256,
    });
    const exitResult = await run(['invalid_exit', '--json'], { commands: [invalidExit] });
    expect(exitResult.out).toBe('');
    expect(exitResult.code).toBe(1);
    expect(JSON.parse(exitResult.err).error).toBe('INTERNAL_SERVER_ERROR');

    const invalidPresenter = defineCliCommand({
      name: 'invalid_presenter',
      description: 'Return invalid presentation bytes',
      input: z.object({}),
      output: ValidOutput,
      handler: () => ValidOutput.parse({ ok: true }),
      present: () => 'valid',
    });
    Reflect.set(invalidPresenter, 'present', () => 42);
    const presenterResult = await run(['invalid_presenter', '--json'], {
      commands: [invalidPresenter],
    });
    expect(presenterResult.out).toBe('');
    expect(presenterResult.code).toBe(1);
    expect(JSON.parse(presenterResult.err).error).toBe('INTERNAL_SERVER_ERROR');

    const ThrowingOutput = z.object({ ok: z.boolean() });
    const throwing = defineCliCommand({
      name: 'throwing_presenter',
      description: 'Throw from presentation policy',
      input: z.object({}),
      output: ThrowingOutput,
      handler: () => ThrowingOutput.parse({ ok: true }),
      present: () => {
        throw new Error('private presenter failure');
      },
    });
    const thrownResult = await run(['throwing_presenter', '--json'], {
      commands: [throwing],
      exitCodes: { INTERNAL_SERVER_ERROR: 9 },
    });
    expect(thrownResult.out).toBe('');
    expect(thrownResult.code).toBe(9);
    expect(JSON.parse(thrownResult.err).error).toBe('INTERNAL_SERVER_ERROR');
    errorSpy.mockRestore();
  });

  if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
    defineCliCommand({
      name: 'invalid_outputless_policy',
      description: 'Compile-only negative probe',
      input: z.object({}),
      handler: () => undefined,
      // @ts-expect-error outputless native commands cannot declare presentation policy.
      present: () => 'not allowed',
    });
  }
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

  test('explicit date and bigint positionals reuse scalar coercion', () => {
    const { toolArgs } = parseCliArgs(
      ['2026-08-23T00:00:00.000Z', '42'],
      z.object({ at: z.date(), count: z.bigint() }),
      { positionals: ['at', 'count'] },
    );
    expect(toolArgs.at).toEqual(new Date('2026-08-23T00:00:00.000Z'));
    expect(toolArgs.count).toBe(42n);
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
