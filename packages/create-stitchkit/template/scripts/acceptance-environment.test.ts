import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptanceEnvironment } from './acceptance-environment';

const root = resolve(import.meta.dir, '..');
const example = readFileSync(
  existsSync(resolve(root, '.env.example'))
    ? resolve(root, '.env.example')
    : resolve(root, '_env.example'),
  'utf8',
);

/** Every variable `.env.example` assigns, commented-out ones included: a deployment may set them. */
function exampleVariables(): Map<string, string> {
  const variables = new Map<string, string>();
  for (const line of example.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) variables.set(match[1], match[2]);
  }
  return variables;
}

describe('the local acceptance environment', () => {
  const variables = exampleVariables();
  const defaultPorts = [variables.get('API_PORT'), variables.get('WEB_PORT')].filter(
    (port): port is string => port !== undefined,
  );
  const addresses = {
    apiPort: 41001,
    webPort: 41002,
    home: '/tmp/pm2',
    databaseUrl: 'postgres://a',
  };
  const environment = acceptanceEnvironment(Object.fromEntries(variables), addresses);

  test('reads the deployment ports and the variables that carry them', () => {
    // Proves the scan works before anything is judged by it.
    expect(defaultPorts).toHaveLength(2);
    expect(
      [...variables].filter(([, value]) =>
        defaultPorts.some((port) => value.includes(`:${port}`)),
      ).length,
    ).toBeGreaterThan(3);
  });

  test('no address copied from .env names a port this run does not own', () => {
    const stale = Object.entries(environment).filter(([, value]) =>
      defaultPorts.some((port) => value.includes(`:${port}`)),
    );
    expect(stale).toEqual([]);
  });

  test('the browser dials the realtime socket on the API role this run started', () => {
    expect(environment.PUBLIC_REALTIME_ORIGIN).toBe('http://127.0.0.1:41001');
    expect(environment.CORS_ORIGIN).toBe('http://127.0.0.1:41002');
    expect(environment.ACCEPTANCE_DATABASE_URL).toBeUndefined();
  });
});
