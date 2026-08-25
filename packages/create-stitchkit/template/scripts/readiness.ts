import type { ProjectDeclaration } from 'stitchkit/declaration';

/** Where a declared role answers once it is ready. */
export interface RoleReadiness {
  name: string;
  url: string;
}

/**
 * The readiness address of every role that listens — from the DECLARATION.
 *
 * Which variable holds the port and which holds the bind address are the
 * role's own statement, so a new role is covered by declaring it rather than by
 * a second list here that would go stale.
 */
export function declaredRoleReadiness(
  declaration: ProjectDeclaration,
  environment: Record<string, string | undefined>,
): RoleReadiness[] {
  return declaration.roles.flatMap((role) => {
    const listener = role.listener;
    if (!listener) return [];
    const port = environment[listener.portVariable];
    // Not skipped: a role that declares a listener and has no port is a
    // deployment that cannot have started it, and quietly waiting for nothing
    // is the failure this module exists to remove.
    if (!port) {
      throw new Error(
        `Role "${role.name}" declares a listener on ${listener.portVariable}, and this environment does not set it.`,
      );
    }
    // `0.0.0.0` is what a role BINDS, never an address to dial: it means every
    // interface, and loopback is the one this machine can always reach.
    const bind = environment[listener.bindVariable];
    const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
    return [
      { name: role.name, url: `http://${authority(host, port)}${listener.readinessPath}` },
    ];
  });
}

/**
 * An IPv6 literal is bracketed; everything else is written as it stands.
 *
 * `http://::1:3211/health` is not an address with a port — it is not a URL at
 * all, and `fetch` refuses it. A role bound to a specific IPv6 address is a
 * legitimate deployment, and it used to make the readiness wait fail on the
 * spelling rather than on the role.
 */
function authority(host: string, port: string): string {
  const literal = host.includes(':') && !host.startsWith('[');
  return `${literal ? `[${host}]` : host}:${port}`;
}

/**
 * Wait until every role answers — because starting is not running.
 *
 * A supervisor returns as soon as it has SPAWNED a process, and a role needs
 * seconds after that before it listens. Printing "running" at the moment of the
 * spawn is a claim nobody checked: the next command in the gate list dialled
 * the declared port and got a connection reset, which reads as a broken check
 * rather than an application still booting.
 */
export async function awaitRolesAnswering(
  roles: readonly RoleReadiness[],
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = [...roles];
  while (pending.length > 0) {
    const role = pending[0];
    if (!role) break;
    if (await answers(role.url)) {
      pending.shift();
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${role.name} did not answer at ${role.url} within ${Math.round(timeoutMs / 1000)}s. It is under the supervisor but not serving — read its output with \`pm2 logs\`.`,
      );
    }
    await Bun.sleep(250);
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}
