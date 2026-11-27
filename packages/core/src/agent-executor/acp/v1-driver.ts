import type { AgentEngineDriver } from '../engine';
import type { ExecutorDriverCapabilities, ExecutorEngineInfo } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { withEphemeralConnection } from '../session-primitives';
import {
  type AcpConnection,
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  connectAcp,
} from './v1-connect';
import { classifyAcpRpcRefusal } from './v1-map';
import {
  type AcpCapabilitiesProbe,
  type AcpProbeCapabilitiesInput,
  probeAcpCapabilities,
  probeAcpModels,
} from './v1-probe';
import { AcpSessionListResultSchema } from './v1-protocol';
import {
  type AcpApprovalEnforcement,
  type AcpOpenInput,
  type AcpSession,
  openAcpSession,
} from './v1-session';

export type { AcpDriverConfig } from './v1-connect';
export type { AcpApprovalEnforcement, AcpSession } from './v1-session';

/** A session the agent keeps, as `session/list` answers. */
export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string | undefined;
  title?: string | undefined;
  updatedAt?: string | undefined;
}

/** An {@link AgentEngineDriver} speaking ACP v1, adding capability probing, session listing, and session config options. */
export interface AcpDriver extends AgentEngineDriver {
  readonly capabilities: ExecutorDriverCapabilities;
  /**
   * How tool approvals are enforced over ACP: always `'agent-initiated'`. The host answers
   * `session/request_permission` requests only when the agent chooses to send them and never
   * synthesizes approvals for unprompted tool calls.
   */
  readonly approvalEnforcement: AcpApprovalEnforcement;
  open(input: AcpOpenInput): Promise<AcpSession>;
  /** The sessions the agent keeps for a working directory; refused if it does not declare `list`. */
  sessions(input: {
    profile: ExecutorProfileConfig;
    cwd: string;
  }): Promise<AcpSessionSummary[]>;
  /**
   * Run a non-inference capability probe (`initialize`, ephemeral `session/new`, `configOptions`,
   * `commands`, `models`) with guaranteed `session/close` + `session/delete` cleanup.
   */
  probeCapabilities(input: AcpProbeCapabilitiesInput): Promise<AcpCapabilitiesProbe>;
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
  const probeMode = config.probeMode ?? 'ephemeral-session';
  const capabilities: ExecutorDriverCapabilities = {
    runtimePolicyEnforcement: 'client-boundary',
    sessionApproval: true,
    interruptOnDeny: false,
    updatedToolInput: false,
    structuredInput: true,
    steer: config.steerMode === 'prompt',
    fork: false,
    revert: false,
    compact: false,
    injectItems: false,
    backgroundWorkOutlivesTurn:
      config.onUpdate !== undefined || config.onPermissionRequest !== undefined,
    multiThreadPerProcess: false,
    images: config.resolveFile !== undefined,
    planLimits: 'none',
  };
  return {
    engine: 'acp',
    reconcile: 'none',
    capabilities,
    approvalEnforcement: 'agent-initiated',
    async info(): Promise<ExecutorEngineInfo> {
      if (probeMode === 'passive') {
        return {
          engine: 'acp',
          version: config.passiveVersion?.trim() || 'unknown',
          reconcile: 'none',
          models: { answer: 'not-asked' },
          capabilities,
        };
      }
      const profile: ExecutorProfileConfig = {
        profileId: 'probe',
        engine: 'acp',
        home: ambientHome(),
      };
      const cwd = process.cwd();
      return probe(config, profile, cwd, async (connection): Promise<ExecutorEngineInfo> => {
        const version = connection.initialized.agentInfo?.version?.trim() || 'unknown';
        if (probeMode === 'initialize-only') {
          return {
            engine: 'acp',
            version,
            reconcile: 'none',
            models: { answer: 'not-asked' },
            capabilities,
          };
        }
        return {
          engine: 'acp',
          version,
          reconcile: 'none',
          models: await probeAcpModels(config, connection, cwd).then(
            (ids): ExecutorEngineInfo['models'] => ({ answer: 'listed', ids }),
            (error: unknown): ExecutorEngineInfo['models'] => ({
              answer: 'failed',
              error:
                (error instanceof Error ? error.message : String(error)) ||
                'the model probe failed without a message',
            }),
          ),
          capabilities,
        };
      });
    },
    /**
     * Whether the agent opens a session without signing in: `session/new`
     * and `session/close` (or `session/delete`). Under `probeMode: 'passive'`
     * or `'initialize-only'`, skips `session/new` and returns honest `unknown`
     * unless `initialize` itself refuses for auth.
     */
    async status(rawProfile) {
      const profile = engineProfile('acp', rawProfile);
      if (probeMode === 'passive') {
        return { login: { state: 'unknown' }, effectiveCredential: 'unknown' };
      }
      try {
        if (probeMode === 'initialize-only') {
          await probe(config, profile, process.cwd(), async () => undefined);
          return { login: { state: 'unknown' }, effectiveCredential: 'unknown' };
        }
        await probe(config, profile, process.cwd(), (connection) =>
          probeAcpModels(config, connection, process.cwd()),
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
    probeCapabilities: (input) => probeAcpCapabilities(config, input),
  };
}
