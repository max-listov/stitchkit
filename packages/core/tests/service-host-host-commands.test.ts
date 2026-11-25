import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  createDefaultLaunchdHostAdapter,
  createDefaultSystemdHostAdapter,
} from '../src/entrypoints/service-host';
import { SYSTEMCTL_PATH } from '../src/service-host/systemd-inspect';

const DECLARED = ['DBUS_SESSION_BUS_ADDRESS', 'HOME', 'XDG_RUNTIME_DIR'] as const;
const PLANTED = 'STITCHKIT_TEST_AMBIENT_ONLY';

/** Run `body` with the ambient values given (`undefined`: unset), restoring each exactly. */
async function withAmbient(
  values: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function parseEnv(stdout: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return env;
}

describe('service-host default adapters run host commands with a declared environment', () => {
  for (const [name, create] of [
    ['systemd', createDefaultSystemdHostAdapter],
    ['launchd', createDefaultLaunchdHostAdapter],
  ] as const) {
    test(`${name}: the command sees a fixed PATH, the declared session keys, and nothing else`, async () => {
      await withAmbient(
        {
          [PLANTED]: 'must-not-pass',
          PATH: '/nonexistent/ambient-bin',
          HOME: '/home/example-user',
          XDG_RUNTIME_DIR: '/run/user/4242',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/4242/bus',
        },
        async () => {
          const result = await create().runCommand('/usr/bin/env', []);
          expect(result.exitCode).toBe(0);
          const env = parseEnv(result.stdout);
          expect([...env.keys()].sort()).toEqual(['PATH', ...DECLARED].sort());
          expect(env.get('PATH')).toBe('/usr/sbin:/usr/bin:/sbin:/bin');
          expect(env.get('HOME')).toBe('/home/example-user');
          expect(env.get('XDG_RUNTIME_DIR')).toBe('/run/user/4242');
          expect(env.get('DBUS_SESSION_BUS_ADDRESS')).toBe('unix:path=/run/user/4242/bus');
        },
      );
    });
  }

  test('a declared key the caller does not have is left out, not passed as an empty or "undefined" value', async () => {
    await withAmbient(
      { XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined, HOME: '/root' },
      async () => {
        const env = parseEnv(
          (await createDefaultSystemdHostAdapter().runCommand('/usr/bin/env', [])).stdout,
        );
        expect([...env.keys()].sort()).toEqual(['HOME', 'PATH']);
      },
    );
  });

  test.skipIf(process.platform !== 'linux')(
    'on Linux the default adapter runs systemctl at its absolute path with no PATH to find it',
    async () => {
      expect(existsSync(SYSTEMCTL_PATH)).toBe(true);
      await withAmbient({ PATH: '/nonexistent' }, async () => {
        const result = await createDefaultSystemdHostAdapter().runCommand(SYSTEMCTL_PATH, [
          '--version',
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^systemd \d+/);
      });
    },
  );
});
