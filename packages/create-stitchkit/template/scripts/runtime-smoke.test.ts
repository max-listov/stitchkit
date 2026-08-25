import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { declaredRoleReadiness } from './readiness';
import { planPortabilityCheck } from './web-surface-smoke';

const dialled = 'http://127.0.0.1:3210';

describe('the portability check dials addresses the deployment claims', () => {
  test('two claimed addresses besides the dialled one become the two probes', () => {
    const plan = planPortabilityCheck(dialled, {
      hosts: '127.0.0.1:3210,alpha.example,beta.example:8443',
    });
    expect(plan.kind).toBe('check');
    if (plan.kind !== 'check') return;
    expect(plan.addresses).toEqual([
      { host: 'alpha.example', proto: 'https' },
      { host: 'beta.example:8443', proto: 'http' },
    ]);
  });

  test('a deployment with nothing but its own address is told what to add', () => {
    // The reported failure, from the other side: the check used to carry two
    // fixture hosts of its own, so a deployment that had never been told about
    // them refused the request and the gate showed a bare 500.
    const plan = planPortabilityCheck(dialled, { hosts: '127.0.0.1:3210' });
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.reason).toContain(
      'PUBLIC_WEB_HOSTS=127.0.0.1:3210,alpha.example,beta.example:8443',
    );
    expect(plan.reason).toContain('bun run dev');
  });

  test('a deployment that claims nothing at all is refused the same way', () => {
    const plan = planPortabilityCheck(dialled, {});
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.reason).toContain('no host at all');
  });

  test('a pinned public origin is a skip with a reason, not a failure', () => {
    // PUBLIC_WEB_ORIGIN short-circuits the request-derived origin, so the
    // deployment answers with one address whatever it is asked on. That is a
    // legitimate configuration; failing it would be a false diagnosis.
    const plan = planPortabilityCheck(dialled, {
      origin: 'https://example.com',
      hosts: '127.0.0.1:3210,alpha.example,beta.example:8443',
    });
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.reason).toContain('https://example.com');
  });

  test('the forged host is never one the deployment claims', () => {
    // Otherwise the refusal the check exists to provoke never happens, and an
    // assertion that cannot fail is worse than no assertion.
    const plan = planPortabilityCheck(dialled, {
      hosts: '127.0.0.1:3210,alpha.example,beta.example:8443,attacker.example',
    });
    expect(plan.kind).toBe('check');
    if (plan.kind !== 'check') return;
    expect(plan.forgedHost).not.toBe('attacker.example');
    expect(plan.forgedHost).toBe('attacker-1.invalid');
  });

  test('one host written twice is one address, not two', () => {
    // The count decides whether the property can be proved at all. Without
    // deduplication a duplicate entry passed as a second address and the check
    // compared the deployment with itself — a proof that cannot fail.
    const plan = planPortabilityCheck(dialled, {
      hosts: '127.0.0.1:3210,alpha.example,alpha.example',
    });
    expect(plan.kind).toBe('refuse');
  });

  test('the claimed list is matched case-insensitively, like the policy that reads it', () => {
    const plan = planPortabilityCheck('http://127.0.0.1:3210', {
      hosts: ' 127.0.0.1:3210 , Alpha.Example , BETA.example:8443 ',
    });
    expect(plan.kind).toBe('check');
    if (plan.kind !== 'check') return;
    expect(plan.addresses.map((address) => address.host)).toEqual([
      'alpha.example',
      'beta.example:8443',
    ]);
  });
});

describe('a gate list is not a deploy instruction', () => {
  // `runtime:smoke` and `e2e` check a running deployment, so the list has to
  // bring one up — and the wrong way to do that shipped once already:
  // `pm2:prod` applies the declared migrations and reloads the deployment the
  // developer is running. A gate creates and destroys its OWN deployment, and
  // that is `acceptance:local`.
  const root = resolve(import.meta.dir, '..');
  const guidance = ['README.md', 'AGENTS.md'];

  for (const file of guidance) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(([, body]) => body ?? '');
    const gates = blocks.filter((body) => body.includes('bun run check'));

    test(`${file} lists gates`, () => {
      expect(gates.length).toBeGreaterThan(0);
    });

    test(`${file} puts no deployment command in the gate list`, () => {
      for (const body of gates) {
        expect(body).not.toContain('pm2:prod');
      }
    });

    test(`${file} brings a deployment up before the checks that dial one`, () => {
      for (const body of gates) {
        const lines = body.split('\n').map((line) => line.trim());
        const dialling = ['bun run runtime:smoke', 'bun run e2e'].filter((command) =>
          lines.includes(command),
        );
        if (dialling.length === 0) {
          expect(lines).toContain('bun run acceptance:local');
          continue;
        }
        const start = lines.indexOf('bun run acceptance:local');
        expect(start).toBeGreaterThanOrEqual(0);
        for (const command of dialling) expect(start).toBeLessThan(lines.indexOf(command));
      }
    });

    test(`${file} never tells anyone to delete every supervised application`, () => {
      // `pm2 delete all` empties the daemon it is pointed at, including
      // applications that have nothing to do with this project.
      expect(text).not.toContain('pm2 delete all');
    });
  }
});

describe('a role is ready when it answers, not when it is spawned', () => {
  const environment = { API_PORT: '3211', WEB_PORT: '3210', BIND_HOST: '127.0.0.1' };

  test('every listening role gets its declared readiness address', () => {
    expect(declaredRoleReadiness(appDeclaration, environment)).toEqual([
      { name: 'api', url: 'http://127.0.0.1:3211/health' },
      { name: 'web', url: 'http://127.0.0.1:3210/' },
    ]);
  });

  test('a bind address of every interface is dialled on loopback', () => {
    // `0.0.0.0` is what a role BINDS. Dialling it as an address is a different
    // question, and loopback is the one this machine can always answer.
    const addresses = declaredRoleReadiness(appDeclaration, {
      ...environment,
      BIND_HOST: '0.0.0.0',
    });
    expect(addresses.every((role) => role.url.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  test('an IPv6 bind address is bracketed, or it is not a URL at all', () => {
    // `http://::1:3211/health` cannot be parsed as an address with a port, so
    // the wait failed on the spelling instead of on the role.
    const addresses = declaredRoleReadiness(appDeclaration, {
      ...environment,
      BIND_HOST: '::1',
    });
    expect(addresses.map((role) => role.url)).toEqual([
      'http://[::1]:3211/health',
      'http://[::1]:3210/',
    ]);
    for (const role of addresses) expect(() => new URL(role.url)).not.toThrow();
  });

  test('a declared listener with no port is an error, not a silent skip', () => {
    expect(() =>
      declaredRoleReadiness(appDeclaration, { ...environment, WEB_PORT: undefined }),
    ).toThrow(/WEB_PORT/);
  });
});
