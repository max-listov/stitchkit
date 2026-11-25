/**
 * Single CLI runner, shared identity resolution, unified global option parsing,
 * and unified native execution across `createCli`, `createCliInvoker` and stream commands.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  CliArgumentError,
  createCli,
  createCliInvoker,
  defineCliCommand,
} from '../src/entrypoints/cli';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { createImplement } from '../src/entrypoints/server';

const GlobalSchema = z.object({
  region: z.string().default('us-east'),
  meta: z.object({ tenant: z.string() }).optional(),
});

const contract = defineContract(
  { prefix: 'ops', scope: 'public' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping with context',
      expose: ['CLI'],
      output: z.object({
        auth: z.string(),
        region: z.string(),
        tenant: z.string().optional(),
      }),
      tool: { name: 'ping' },
    },
    feed: {
      method: 'POST',
      path: '/feed',
      desc: 'Stream events',
      expose: ['CLI'],
      stream: { item: z.object({ auth: z.string(), region: z.string(), n: z.number() }) },
    },
  },
);

describe('unified CLI runner and global option parsing', () => {
  test('one resolveAuth spy runs once across createCli, createCliInvoker and stream paths with identical typedGlobals', async () => {
    const seenAuthGlobals: Array<z.output<typeof GlobalSchema>> = [];
    const seenContextGlobals: Array<z.output<typeof GlobalSchema>> = [];
    type AppCtx = RuntimeContext & { auth: string; globals: z.output<typeof GlobalSchema> };
    const service = createImplement<AppCtx>()(contract, {
      ping: ({ auth, globals }) => ({
        auth,
        region: globals.region,
        tenant: globals.meta?.tenant,
      }),
      feed: async function* ({ auth, globals }) {
        yield { auth, region: globals.region, n: 1 };
      },
    });

    const baseConfig = {
      name: 'runner-fixture',
      version: '1.0.0',
      services: [service],
      access: { open: 'local-operator' } as const,
      globalOptions: GlobalSchema,
      resolveAuth: (globals: z.output<typeof GlobalSchema>) => {
        seenAuthGlobals.push(globals);
        return `id:${globals.region}:${globals.meta?.tenant ?? 'none'}`;
      },
      context: (auth: string | undefined, globals: z.output<typeof GlobalSchema>) => {
        seenContextGlobals.push(globals);
        return { auth: auth ?? 'missing', globals };
      },
    };

    // 1. createCli managed path with JSON-string global option + default
    let cliOut = '';
    let cliCode = -1;
    await createCli({
      ...baseConfig,
      argv: ['ping', '--meta', '{"tenant":"acme"}', '--json'],
      stdin: async () => null,
      stdout: (text) => {
        cliOut += text;
      },
      stderr: () => undefined,
      exit: (value) => {
        cliCode = value;
      },
    });
    expect(cliCode).toBe(0);
    expect(JSON.parse(cliOut)).toEqual({
      auth: 'id:us-east:acme',
      region: 'us-east',
      tenant: 'acme',
    });

    // 2. createCliInvoker with the exact same JSON-string global option + default
    const invoker = await createCliInvoker(baseConfig, { meta: '{"tenant":"acme"}' });
    const invResult = await invoker.invoke('ping', {});
    expect(invResult).toEqual({
      ok: true,
      exitCode: 0,
      data: { auth: 'id:us-east:acme', region: 'us-east', tenant: 'acme' },
    });

    // 3. createCli stream path with the same JSON-string global option + default
    let streamOut = '';
    let streamErr = '';
    let streamCode = -1;
    await createCli({
      ...baseConfig,
      argv: ['feed_op', '--meta', '{"tenant":"acme"}'],
      stdin: async () => null,
      stdout: (text) => {
        streamOut += text;
      },
      stderr: (text) => {
        streamErr += text;
      },
      exit: (value) => {
        streamCode = value;
      },
    });
    expect(streamErr).toBe('');
    expect(streamCode).toBe(0);
    expect(JSON.parse(streamOut.trim())).toEqual({
      auth: 'id:us-east:acme',
      region: 'us-east',
      n: 1,
    });

    // All three paths resolved auth once each and produced identical typedGlobals.
    expect(seenAuthGlobals).toEqual([
      { region: 'us-east', meta: { tenant: 'acme' } },
      { region: 'us-east', meta: { tenant: 'acme' } },
      { region: 'us-east', meta: { tenant: 'acme' } },
    ]);
    expect(seenContextGlobals).toEqual(seenAuthGlobals);
  });

  test('createCliInvoker throws CliArgumentError on invalid global option', async () => {
    const error = await createCliInvoker(
      {
        name: 'runner-fixture',
        globalOptions: z.object({ retries: z.number().int().min(1) }),
      },
      { retries: 0 },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliArgumentError);
    if (error instanceof CliArgumentError) {
      expect(error.message).toContain('--retries');
    }
  });

  test('native command without output refuses --table/--sort/--sum/--count-by with code 2 and zero calls', async () => {
    let calls = 0;
    const printing = defineCliCommand({
      name: 'print',
      description: 'Prints directly',
      input: z.object({}),
      handler: ({ stdout }) => {
        calls++;
        stdout('printed\n');
      },
    });
    for (const flags of [
      ['--table', 'x'],
      ['--sort', 'x'],
      ['--sum', 'x'],
      ['--count-by', 'x'],
    ]) {
      let out = '';
      let err = '';
      let code = -1;
      await createCli({
        name: 'runner-fixture',
        version: '1.0.0',
        commands: [printing],
        argv: ['print', ...flags],
        stdin: async () => null,
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
        exit: (value) => {
          code = value;
        },
      });
      expect(code).toBe(2);
      expect(calls).toBe(0);
      expect(out).toBe('');
      expect(err).toContain('without an output schema');
    }
  });
});
