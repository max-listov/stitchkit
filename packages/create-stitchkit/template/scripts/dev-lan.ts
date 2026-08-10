import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { appIdentity } from '../packages/config/src/identity';
import { childEnvironment, env } from '../packages/config/src/server';
import { runDevelopment } from './dev';

export function privateLanAddresses(
  interfaces: ReturnType<typeof networkInterfaces>,
): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [first, second] = entry.address.split('.').map(Number);
      if (
        first === 10 ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      ) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses].sort();
}

export function selectLanAddress(addresses: readonly string[], requested?: string): string {
  if (requested) {
    if (!addresses.includes(requested)) {
      throw new Error(
        `Requested LAN address ${requested} is unavailable. Detected: ${addresses.join(', ') || '(none)'}`,
      );
    }
    return requested;
  }
  if (addresses.length !== 1) {
    throw new Error(
      `LAN address is ${addresses.length === 0 ? 'unavailable' : 'ambiguous'}. Use --host <address>. Detected: ${addresses.join(', ') || '(none)'}`,
    );
  }
  return addresses[0];
}

async function run(command: string[], environment?: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, {
    env: environment ? childEnvironment(environment) : undefined,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
  return output.trim();
}

function requestedHost(args: readonly string[]): string | undefined {
  const index = args.indexOf('--host');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error('--host requires an IPv4 address');
  return value;
}

async function ensureCertificates(host: string) {
  if (!Bun.which('mkcert')) {
    throw new Error(
      'dev:lan requires mkcert. Install it with `brew install mkcert` (macOS/Linuxbrew) or the official prebuilt binary, then rerun.',
    );
  }
  const caRoot = await run(['mkcert', '-CAROOT']);
  const ca = join(caRoot, 'rootCA.pem');
  if (!(await Bun.file(ca).exists())) await run(['mkcert', '-install']);

  const directory = join(homedir(), '.local', 'share', appIdentity.slug, 'lan-https');
  const cert = join(directory, 'leaf.pem');
  const key = join(directory, 'leaf-key.pem');
  const marker = join(directory, 'host');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readFile(marker, 'utf8').catch(() => '');
  if (
    previous.trim() !== host ||
    !(await Bun.file(cert).exists()) ||
    !(await Bun.file(key).exists())
  ) {
    await run([
      'mkcert',
      '-cert-file',
      cert,
      '-key-file',
      key,
      host,
      'localhost',
      '127.0.0.1',
      '::1',
    ]);
    await writeFile(marker, `${host}\n`, { mode: 0o600 });
  }
  return { ca, cert, key };
}

async function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (occupied: boolean, socket?: { end(): void }) => {
      if (settled) return;
      settled = true;
      resolve(occupied);
      socket?.end();
    };
    void Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (socket) => finish(true, socket),
        data: () => undefined,
        close: () => finish(false),
        error: () => finish(false),
      },
    }).catch(() => finish(false));
  });
}

async function assertDevelopmentPortsAvailable(): Promise<void> {
  const processList = await run(['pm2', 'jlist']);
  const onlineNames = new Set(
    z
      .array(
        z.object({
          name: z.string(),
          pm2_env: z.object({ status: z.string() }),
        }),
      )
      .parse(JSON.parse(processList))
      .filter((process) => process.pm2_env.status === 'online')
      .map((process) => process.name),
  );
  const expected = new Map([
    [env.WEB_PORT, `${appIdentity.slug}-frontend-dev`],
    [env.API_PORT, `${appIdentity.slug}-backend-dev`],
  ]);
  for (const [port, owner] of expected) {
    if ((await isPortOccupied(port)) && !onlineNames.has(owner)) {
      throw new Error(`Port ${port} is occupied by a process outside ${owner}`);
    }
  }
}

if (import.meta.main) {
  if (env.NODE_ENV !== 'development') {
    throw new Error('dev:lan is development-only');
  }
  const host = selectLanAddress(
    privateLanAddresses(networkInterfaces()),
    requestedHost(Bun.argv),
  );
  await assertDevelopmentPortsAvailable();
  const certificates = await ensureCertificates(host);
  const apiOrigin = `https://${host}:${env.API_PORT}`;
  const webOrigin = `https://${host}:${env.WEB_PORT}`;
  await runDevelopment({
    CORS_ORIGIN: webOrigin,
    DEV_HTTPS_CA: certificates.ca,
    DEV_HTTPS_CERT: certificates.cert,
    DEV_HTTPS_KEY: certificates.key,
    INTERNAL_API_URL: apiOrigin,
    NEXT_PUBLIC_API_URL: apiOrigin,
    NEXT_PUBLIC_WEB_URL: webOrigin,
    NODE_EXTRA_CA_CERTS: certificates.ca,
  });
  console.log(`${appIdentity.name} trusted LAN development is running`);
  console.log(`Web: ${webOrigin}/en`);
  console.log(`API: ${apiOrigin}`);
  console.log(`Device CA setup: ${apiOrigin}/__dev/lan`);
}
