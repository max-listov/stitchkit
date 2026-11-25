import type { AgentEngineDriver } from '../engine';
import type { ExecutorEngineInfo } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { withEphemeralConnection } from '../session-primitives';
import {
  type AcpConnection,
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  closeRequestTimeoutMs,
  connectAcp,
} from './v1-connect';
import { classifyAcpRpcRefusal } from './v1-map';
import {
  AcpNewSessionResultSchema,
  AcpSessionListResultSchema,
  acpOptionValues,
} from './v1-protocol';
import { type AcpSession, openAcpSession } from './v1-session';

export type { AcpDriverConfig } from './v1-connect';
export type { AcpSession } from './v1-session';

/** A session the agent keeps, as `session/list` answers. */
export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

/** An {@link AgentEngineDriver} speaking ACP v1, adding session listing and session config options. */
export interface AcpDriver extends AgentEngineDriver {
  open(input: Parameters<AgentEngineDriver['open']>[0]): Promise<AcpSession>;
  /** The sessions the agent keeps for a working directory; refused if it does not declare `list`. */
  sessions(input: {
    profile: ExecutorProfileConfig;
    cwd: string;
  }): Promise<AcpSessionSummary[]>;
}

/**
 * Open a connection for one question and close it: no prompt, no inference.
 * The agent's own login is never started — a sign-in it needs is a refusal.
 */
function probe<T>(
  config: AcpDriverConfig,
  profile: ExecutorProfileConfig,
  cwd: string,
  ask: (connection: AcpConnection) => Promise<T>,
): Promise<T> {
  return withEphemeralConnection((signal) => connectAcp(config, profile, cwd, signal), ask);
}

/** The values of the session's model option, or its model list; none when the agent offers neither. */
async function probeModels(
  config: AcpDriverConfig,
  connection: AcpConnection,
  cwd: string,
): Promise<string[]> {
  const session = AcpNewSessionResultSchema.parse(
    await connection.peer.request('session/new', { cwd, mcpServers: [] }),
  );
  if (acpCan(connection, 'close')) {
    await connection.peer
      .request(
        'session/close',
        { sessionId: session.sessionId },
        { timeoutMs: closeRequestTimeoutMs(config) },
      )
      .catch(() => undefined);
  }
  const option = session.configOptions?.find((candidate) => candidate.category === 'model');
  if (option !== undefined) return acpOptionValues(option);
  return session.models?.availableModels?.map((model) => model.modelId) ?? [];
}

/**
 * An agent speaking the Agent Client Protocol v1 over stdio. A session per
 * connection; `session/prompt` runs a turn and answers with its stop reason;
 * `session/cancel` interrupts it, and a permission request still pending is
 * answered `cancelled` so the agent is never left waiting. ACP has no client
 * id an agent keeps, so a send whose outcome is unknown stays unknown.
 */
export function createAcpDriver(config: AcpDriverConfig): AcpDriver {
  assertAcpDriverOptions(config);
  const ambientHome = () => (config.ambient ?? process.env).HOME ?? '/';
  return {
    engine: 'acp',
    reconcile: 'none',
    async info() {
      const profile = { profileId: 'probe', engine: 'acp' as const, home: ambientHome() };
      const cwd = process.cwd();
      return probe(config, profile, cwd, async (connection) => ({
        engine: 'acp' as const,
        version: connection.initialized.agentInfo?.version?.trim() || 'unknown',
        reconcile: 'none' as const,
        models: await probeModels(config, connection, cwd).then(
          (ids): ExecutorEngineInfo['models'] => ({ answer: 'listed', ids }),
          (error: unknown): ExecutorEngineInfo['models'] => ({
            answer: 'failed',
            error:
              (error instanceof Error ? error.message : String(error)) ||
              'the model probe failed without a message',
          }),
        ),
      }));
    },
    /**
     * Whether the agent opens a session without signing in: `session/new`
     * and `session/close`. An agent lists `authMethods` while signed in too,
     * so the list says nothing; a session refused for auth is `signed-out`.
     */
    async status(rawProfile) {
      const profile = engineProfile('acp', rawProfile);
      try {
        await probe(config, profile, process.cwd(), (connection) =>
          probeModels(config, connection, process.cwd()),
        );
        return { login: { state: 'signed-in' }, effectiveCredential: 'unknown' };
      } catch (error) {
        const signedOut = classifyAcpRpcRefusal(error) === 'authRequired';
        return {
          login: { state: signedOut ? 'signed-out' : 'unknown' },
          effectiveCredential: signedOut ? 'none' : 'unknown',
        };
      }
    },
    async open(input) {
      return openAcpSession(config, {
        ...input,
        profile: engineProfile('acp', input.profile),
      });
    },
    async sessions(input) {
      const profile = engineProfile('acp', input.profile);
      return probe(config, profile, input.cwd, async (connection) => {
        if (!acpCan(connection, 'list'))
          throw new Error('The ACP agent does not list its sessions');
        const listed = AcpSessionListResultSchema.parse(
          await connection.peer.request('session/list', { cwd: input.cwd }),
        );
        return listed.sessions.map((session) => ({
          sessionId: session.sessionId,
          ...(session.cwd !== undefined && { cwd: session.cwd }),
          ...(typeof session.title === 'string' && { title: session.title }),
          ...(typeof session.updatedAt === 'string' && { updatedAt: session.updatedAt }),
        }));
      });
    },
  };
}
