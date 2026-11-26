import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type ClaudeTurnState,
  classifyClaudeRecord,
  newClaudeTurnState,
} from '../claude/classify';
import type { ClaudeRuntimeEvent } from '../claude/events';
import { claudePlanWindows } from '../claude/limits';
import {
  type ClaudePendingPermissionDetail,
  resolveClaudePermissionReply,
} from '../claude/protocol';
import type { AgentEngineTurn } from '../engine';
import {
  answerEngineRequest,
  drainEngineRequests,
  type EngineRequestTurn,
  endEngineTurn,
  holdEngineRequest,
} from '../engine-requests';
import type { PlanLimits } from '../hello';
import { mergeRateLimitEvent } from '../plan-limits';
import {
  invokeSafely,
  nonEmptyString,
  offerTurnDelta,
  safeJsonValue,
} from '../session-primitives';
import type { ClaudeSdkRun } from './driver';
import { type ClaudeSdkTurnUsage, createClaudeSdkTurnUsageTracker } from './turn-usage';

/** Structured metadata captured from a Claude Agent SDK `canUseTool` permission request. */
export interface ClaudeSdkPermissionRequestMeta {
  /** Turn identifier of the active turn receiving this permission request. */
  readonly turnId: string;
  /** Interaction identifier matching the emitted `request` delta and `turn.respond()`. */
  readonly interactionId: string;
  /** Raw tool name supplied by the SDK (for example `'AskUserQuestion'`, `'ExitPlanMode'`, `'Bash'`). */
  readonly toolName: string;
  /** Bounded JSON snapshot of the tool input passed to `canUseTool`. */
  readonly input: Record<string, unknown>;
  /** Tool call identifier (`options.toolUseID`). */
  readonly toolUseID: string;
  /** Control request identifier (`options.requestId`) when provided. */
  readonly requestId?: string;
  /** Why Claude Code triggered this permission request (`options.decisionReason`). */
  readonly decisionReason?: string;
  /** File path that triggered the permission request (`options.blockedPath`). */
  readonly blockedPath?: string;
  /** Primary prompt title rendered by Claude Code (`options.title`). */
  readonly title?: string;
  /** Short action label (`options.displayName`). */
  readonly displayName?: string;
  /** Human-readable subtitle (`options.description`). */
  readonly description?: string;
  /** Permission rule suggestions from the SDK (`options.suggestions`). */
  readonly suggestions?: readonly PermissionUpdate[];
  /** Subagent identifier when invoked inside a subagent (`options.agentID`). */
  readonly agentID?: string;
  /** MCP server attribution when the tool belongs to an MCP server (`options.mcpServer`). */
  readonly mcpServer?: { readonly name: string; readonly source: string };
  /** Whether the prompt should default to decline (`options.defaultToNo`). */
  readonly defaultToNo?: boolean;
  /** Whether persistent "always allow" rules are suppressed (`options.suppressAlwaysAllowRule`). */
  readonly suppressAlwaysAllowRule?: boolean;
  /** Ask rule that forced this prompt (`options.matchedAskRule`). */
  readonly matchedAskRule?: {
    readonly source: string;
    readonly toolName: string;
    readonly ruleContent?: string;
  };
}

/** A running turn: its state, its deltas and the `canUseTool` calls it holds, with their input. */
export interface SdkTurnSlot
  extends EngineRequestTurn<
    PermissionResult,
    ClaudePendingPermissionDetail<Record<string, unknown>>
  > {
  readonly state: ClaudeTurnState;
}

/** One active Agent SDK query handle managed by a session. */
export interface RunningQueryHandle {
  readonly query: ClaudeSdkRun;
  send(message: SDKUserMessage): void;
  startLoop(): void;
  close(): void;
}

const SDK_ANSWER = { source: 'claude-sdk', type: 'PermissionResult' };

/** The answer to every `canUseTool` call a stopped turn still holds: deny, and interrupt the SDK's turn. */
export const stoppedPermission = (message: string) => (): PermissionResult => ({
  behavior: 'deny',
  message,
  interrupt: true,
});

/** Invoke `query.close?.()` while containing synchronous throws and async rejections. */
export function closeQuerySafely(query: ClaudeSdkRun | undefined): void {
  invokeSafely(() => query?.close?.());
}

/** The prompt a query reads: user messages pushed one at a time, ended on close. */
export function pushablePrompt() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    prompt: prompt(),
    send(message: SDKUserMessage) {
      queue.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/** Bridge SDK `canUseTool` callbacks into turn `request` deltas with bounded JSON input. */
export function createSdkCanUseTool(state: {
  getTurn: () => SdkTurnSlot | undefined;
  isClosed: () => boolean;
  onPermissionRequest?: (meta: ClaudeSdkPermissionRequestMeta) => void;
}): CanUseTool {
  return (toolName, toolInput, options) =>
    new Promise<PermissionResult>((resolve) => {
      const turn = state.getTurn();
      if (turn === undefined || state.isClosed() || options.signal.aborted) {
        resolve({ behavior: 'deny', message: 'No turn is running to ask' });
        return;
      }
      const interactionId = randomUUID();
      const finish = (result: PermissionResult) => {
        options.signal.removeEventListener('abort', onToolAbort);
        resolve(result);
      };
      const onToolAbort = () => {
        answerEngineRequest(turn, interactionId, {
          behavior: 'deny',
          message: 'The tool request was aborted',
          interrupt: true,
        });
      };
      const callId = nonEmptyString(options.toolUseID);
      const rawToolName = nonEmptyString(toolName);
      let safeInputSnapshot: Record<string, unknown> | undefined;
      holdEngineRequest(turn, {
        interactionId,
        detail: {
          input: toolInput,
          toolName: rawToolName,
          suppressSessionRule: options.suppressAlwaysAllowRule === true,
        },
        answeredBy: SDK_ANSWER,
        delta: () => {
          const safeInput = safeJsonValue(toolInput);
          if (
            typeof safeInput === 'object' &&
            safeInput !== null &&
            !Array.isArray(safeInput)
          ) {
            safeInputSnapshot = safeInput;
          }
          return {
            type: 'request',
            turnId: turn.state.turnId,
            itemId: `request:${interactionId}`,
            raw: { source: 'claude-sdk', type: 'canUseTool' },
            interactionId,
            kind: 'approval',
            toolName: rawToolName ?? 'tool',
            ...(callId !== undefined && { callId }),
            input: safeInput,
          };
        },
        refusal: { behavior: 'deny', message: 'The turn was interrupted', interrupt: true },
        resolve: finish,
      });
      if (turn.pending.has(interactionId)) {
        options.signal.addEventListener('abort', onToolAbort, { once: true });
        if (state.onPermissionRequest !== undefined) {
          const meta: ClaudeSdkPermissionRequestMeta = {
            turnId: turn.state.turnId,
            interactionId,
            toolName,
            input: safeInputSnapshot ?? {},
            toolUseID: options.toolUseID,
            ...(options.requestId !== undefined && { requestId: options.requestId }),
            ...(options.decisionReason !== undefined && {
              decisionReason: options.decisionReason,
            }),
            ...(options.blockedPath !== undefined && { blockedPath: options.blockedPath }),
            ...(options.title !== undefined && { title: options.title }),
            ...(options.displayName !== undefined && { displayName: options.displayName }),
            ...(options.description !== undefined && { description: options.description }),
            ...(options.suggestions !== undefined && {
              suggestions: [...options.suggestions],
            }),
            ...(options.agentID !== undefined && { agentID: options.agentID }),
            ...(options.mcpServer !== undefined && { mcpServer: { ...options.mcpServer } }),
            ...(options.defaultToNo !== undefined && { defaultToNo: options.defaultToNo }),
            ...(options.suppressAlwaysAllowRule !== undefined && {
              suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
            }),
            ...(options.matchedAskRule !== undefined && {
              matchedAskRule: { ...options.matchedAskRule },
            }),
          };
          invokeSafely(() => state.onPermissionRequest?.(meta));
        }
      }
    });
}

/** The turn as the executor steers it: interrupt through the query, answer permissions. */
export function sdkTurnHandle(turn: SdkTurnSlot, query: ClaudeSdkRun): AgentEngineTurn {
  return {
    deltas: turn.channel,
    async interrupt() {
      turn.state.interruptRequested = true;
      drainEngineRequests(turn, stoppedPermission('The turn was interrupted'));
      await query.interrupt();
    },
    async respond(interactionId, rawReply) {
      const waiting = turn.pending.get(interactionId);
      if (waiting === undefined) {
        throw new TypeError(`Unknown interaction ${interactionId} for this turn`);
      }
      const decision = resolveClaudePermissionReply(waiting.detail, rawReply);
      if (decision.behavior === 'allow') {
        answerEngineRequest(turn, interactionId, {
          behavior: 'allow',
          updatedInput: decision.input,
          ...(decision.updatedPermissions !== undefined && {
            updatedPermissions: decision.updatedPermissions.map((rule) => ({
              type: rule.type,
              rules: rule.rules.map((entry) => ({ toolName: entry.toolName })),
              behavior: rule.behavior,
              destination: rule.destination,
            })),
          }),
        });
        return;
      }
      answerEngineRequest(turn, interactionId, decision);
    },
  };
}

/** Background drain loop routing one query's records to the active turn, limits map, and observers. */
export function runSdkQueryLoop(input: {
  handle: RunningQueryHandle;
  profileId: string;
  limits: Map<string, PlanLimits>;
  getTurn: () => SdkTurnSlot | undefined;
  clearTurn: () => void;
  onEvent?: (event: ClaudeRuntimeEvent) => void;
  onTurnUsage?: (usage: ClaudeSdkTurnUsage) => void;
  onExit: (handle: RunningQueryHandle, error: unknown) => void;
}): void {
  const turnUsageTracker = createClaudeSdkTurnUsageTracker();
  let sessionModel: string | undefined;
  void (async () => {
    try {
      for await (const record of input.handle.query) {
        const turn = input.getTurn();
        const verdict = classifyClaudeRecord(
          record,
          turn?.state ?? newClaudeTurnState('between-turns'),
        );
        if (verdict.kind === 'session') {
          if (verdict.model !== undefined) sessionModel = verdict.model;
        } else if (verdict.kind === 'limits') {
          input.limits.set(
            input.profileId,
            mergeRateLimitEvent({
              previous: input.limits.get(input.profileId),
              windows: claudePlanWindows(verdict.info),
              now: new Date(),
            }),
          );
        } else if (verdict.kind === 'event') {
          if (input.onEvent !== undefined) {
            invokeSafely(() => input.onEvent?.(verdict.event));
          }
        } else if (verdict.kind === 'deltas') {
          for (const delta of verdict.deltas) offerTurnDelta(turn?.channel, delta);
        } else if (verdict.kind === 'end') {
          const usageDelta = verdict.deltas.find((delta) => delta.type === 'usage');
          const primaryModel = turn?.state.primaryModel ?? sessionModel;
          const summary = turnUsageTracker.recordTurn({
            turnId: turn?.state.turnId ?? 'between-turns',
            ...(primaryModel !== undefined && { primaryModel }),
            ...(usageDelta?.type === 'usage' && { usageDelta }),
          });
          if (turn !== undefined && input.onTurnUsage !== undefined) {
            invokeSafely(() => input.onTurnUsage?.(summary));
          }
          endEngineTurn(turn, stoppedPermission('The turn ended'), verdict.deltas);
          input.clearTurn();
        } else if (verdict.kind === 'unhandled') {
          offerTurnDelta(turn?.channel, verdict.delta);
        }
      }
      throw new Error(
        input.getTurn() !== undefined
          ? 'The Agent SDK query ended during the turn'
          : 'The Agent SDK query ended while idle',
      );
    } catch (error) {
      input.onExit(input.handle, error);
    }
  })();
}
