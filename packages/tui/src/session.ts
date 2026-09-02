import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MAX_REQUEST_BYTES = 65_536;

export const AgentTuiSessionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(8),
    conversationId: z.string().min(1),
    socketPath: z.string().min(1),
    token: z.string().min(32),
    pid: z.int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AgentTuiSessionRequestSchema = z.discriminatedUnion('operation', [
  z.object({ requestId: z.string().min(1), operation: z.literal('status') }).strict(),
  z
    .object({
      requestId: z.string().min(1),
      operation: z.literal('submit'),
      text: z.string().min(1),
      idempotencyKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1),
      operation: z.literal('interrupt'),
      runId: z.string().min(1).optional(),
    })
    .strict(),
]);

export const AgentTuiSessionResponseSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      requestId: z.string().min(1),
      outcome: z.literal('ok'),
      sessionId: z.string().min(1),
      conversationId: z.string().min(1),
      runId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1),
      outcome: z.literal('error'),
      error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
    })
    .strict(),
]);

export type AgentTuiSessionDescriptor = z.infer<typeof AgentTuiSessionDescriptorSchema>;
export type AgentTuiSessionRequest = z.infer<typeof AgentTuiSessionRequestSchema>;
export type AgentTuiSessionResponse = z.infer<typeof AgentTuiSessionResponseSchema>;

export function createAgentTuiSessionId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

export function createAgentTuiConversationId(): string {
  return `conversation-${crypto.randomUUID()}`;
}

function sessionsDirectory(rootDirectory: string): string {
  return path.join(rootDirectory, '.stitchkit', 'tui', 'sessions');
}

function descriptorPath(rootDirectory: string, sessionId: string): string {
  return path.join(sessionsDirectory(rootDirectory), `${sessionId}.json`);
}

/**
 * Reachability, which is NOT liveness — and here that is enough only because of what it is paired
 * with. `process.kill(pid, 0)` succeeds for a zombie: an exited child its parent has not reaped
 * keeps its table entry, so this answers "alive" for a process that is finished (→ ADR 0149, where
 * the journal lock had to stop believing it). A session descriptor survives that only because
 * `listAgentTuiSessions` requires a socket round trip as well, and a zombie answers nothing.
 *
 * So this check cannot carry the decision on its own — and that is enforced rather than requested:
 * `packages/tui/tests/session.test.ts::does not publish a stale descriptor merely because its pid
 * was reused` writes a descriptor holding a genuinely live pid and a socket that answers nothing,
 * and dropping the `probeDescriptor` half of the condition reddens exactly that test. Verified by
 * removing it, not by reading.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function readDescriptor(
  rootDirectory: string,
  sessionId: string,
): Promise<AgentTuiSessionDescriptor> {
  const descriptor = AgentTuiSessionDescriptorSchema.parse(
    JSON.parse(await readFile(descriptorPath(rootDirectory, sessionId), 'utf8')),
  );
  const expectedSocket = path.join(sessionsDirectory(rootDirectory), `${sessionId}.sock`);
  if (descriptor.sessionId !== sessionId || descriptor.socketPath !== expectedSocket) {
    throw new Error('Agent TUI session descriptor identity does not match its path');
  }
  return descriptor;
}

async function probeDescriptor(
  descriptor: AgentTuiSessionDescriptor,
  timeoutMs = 500,
): Promise<boolean> {
  try {
    const requestId = crypto.randomUUID();
    const response = await fetch('http://localhost/request', {
      method: 'POST',
      unix: descriptor.socketPath,
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId, operation: 'status' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const parsed = AgentTuiSessionResponseSchema.safeParse(await response.json());
    return (
      parsed.success &&
      parsed.data.outcome === 'ok' &&
      parsed.data.requestId === requestId &&
      parsed.data.sessionId === descriptor.sessionId
    );
  } catch {
    return false;
  }
}

async function writeDescriptor(
  rootDirectory: string,
  descriptor: AgentTuiSessionDescriptor,
): Promise<void> {
  const directory = sessionsDirectory(rootDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filename = descriptorPath(rootDirectory, descriptor.sessionId);
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, filename);
  await chmod(filename, 0o600);
}

async function removeDescriptor(
  rootDirectory: string,
  descriptor: AgentTuiSessionDescriptor,
): Promise<void> {
  const expectedSocket = path.join(
    sessionsDirectory(rootDirectory),
    `${descriptor.sessionId}.sock`,
  );
  if (descriptor.socketPath === expectedSocket) {
    await unlink(expectedSocket).catch(() => undefined);
  }
  await unlink(descriptorPath(rootDirectory, descriptor.sessionId)).catch(() => undefined);
}

export async function listAgentTuiSessions(
  rootDirectory: string,
): Promise<readonly AgentTuiSessionDescriptor[]> {
  const directory = sessionsDirectory(rootDirectory);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const descriptors: AgentTuiSessionDescriptor[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const sessionId = name.slice(0, -'.json'.length);
      const descriptor = await readDescriptor(rootDirectory, sessionId);
      if (!processAlive(descriptor.pid) || !(await probeDescriptor(descriptor))) {
        await removeDescriptor(rootDirectory, descriptor);
        continue;
      }
      descriptors.push(descriptor);
    } catch {
      // A damaged or foreign descriptor is not a live session.
      await unlink(path.join(directory, name)).catch(() => undefined);
    }
  }
  return descriptors;
}

export interface AgentTuiSessionHost {
  sessionId: string;
  socketPath: string;
  setConversationId(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startAgentTuiSessionHost(input: {
  rootDirectory: string;
  conversationId: string;
  sessionId?: string;
  handle(request: AgentTuiSessionRequest): Promise<AgentTuiSessionResponse>;
}): Promise<AgentTuiSessionHost> {
  for (const descriptor of await listAgentTuiSessions(input.rootDirectory)) {
    if (!processAlive(descriptor.pid)) await removeDescriptor(input.rootDirectory, descriptor);
  }
  const sessionId = input.sessionId ?? createAgentTuiSessionId();
  const socketPath = path.join(sessionsDirectory(input.rootDirectory), `${sessionId}.sock`);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  let conversationId = input.conversationId;
  let descriptor = AgentTuiSessionDescriptorSchema.parse({
    schemaVersion: 1,
    sessionId,
    conversationId,
    socketPath,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      unix: socketPath,
      async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${token}`) {
          return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
        }
        const declaredLength = Number(request.headers.get('content-length') ?? '0');
        if (declaredLength > MAX_REQUEST_BYTES) {
          return Response.json({ error: 'REQUEST_TOO_LARGE' }, { status: 413 });
        }
        const body = await request.text();
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
          return Response.json({ error: 'REQUEST_TOO_LARGE' }, { status: 413 });
        }
        try {
          const parsed = AgentTuiSessionRequestSchema.parse(JSON.parse(body));
          return Response.json(await input.handle(parsed));
        } catch {
          return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
        }
      },
    });
    await chmod(socketPath, 0o600);
    await writeDescriptor(input.rootDirectory, descriptor);
  } catch (error) {
    server?.stop(true);
    await unlink(socketPath).catch(() => undefined);
    await unlink(descriptorPath(input.rootDirectory, sessionId)).catch(() => undefined);
    throw error;
  }
  return {
    sessionId,
    socketPath,
    async setConversationId(nextConversationId) {
      conversationId = nextConversationId;
      descriptor = AgentTuiSessionDescriptorSchema.parse({
        ...descriptor,
        conversationId,
      });
      await writeDescriptor(input.rootDirectory, descriptor);
    },
    async close() {
      server.stop(true);
      await unlink(socketPath).catch(() => undefined);
      await unlink(descriptorPath(input.rootDirectory, sessionId)).catch(() => undefined);
    },
  };
}

export interface AgentTuiClient {
  request(request: AgentTuiSessionRequest): Promise<AgentTuiSessionResponse>;
}

export async function createAgentTuiClient(input: {
  rootDirectory: string;
  sessionId: string;
  timeoutMs?: number;
}): Promise<AgentTuiClient> {
  const descriptor = await readDescriptor(input.rootDirectory, input.sessionId);
  const timeoutMs = input.timeoutMs ?? 5_000;
  return {
    async request(request) {
      const response = await fetch('http://localhost/request', {
        method: 'POST',
        unix: descriptor.socketPath,
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(AgentTuiSessionRequestSchema.parse(request)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`TUI session request failed with HTTP ${response.status}`);
      return AgentTuiSessionResponseSchema.parse(await response.json());
    },
  };
}
