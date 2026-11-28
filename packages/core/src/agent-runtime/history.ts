import type {
  AgentModelFileData,
  AgentModelMessage,
  AgentToolModelOutput,
} from '../agent-parts/model';
import type { AgentToolSet } from '../tools/agent-tools';
import {
  advanceToolChronology,
  canProjectToolChronology,
  createToolChronology,
} from './history-chronology';
import {
  type HistoryPartType,
  projectAssistantMessages,
  projectUserMessage,
  textContent,
} from './run-history-parts';
import type { AgentMessage, AgentMessagePart } from './schemas';
import {
  type AgentHistoryEvidencePolicy,
  isAssistantHistoryEvidence,
} from './terminal-status';

export interface AgentHistoryProjectionOptions {
  evidencePolicy?: AgentHistoryEvidencePolicy;
  resolveFile?(
    part: Extract<AgentMessagePart, { type: 'file' }>,
    message: AgentMessage,
  ): AgentModelFileData | Promise<AgentModelFileData>;
  /**
   * Mounted tools whose `toModelOutput` projects persisted successful `tool-result`
   * parts back into structured/multimodal `AgentToolModelOutput` on later turns.
   */
  tools?: AgentToolSet;
  /**
   * Optional per-result override projecting a persisted `tool-result` part into a
   * model-facing `AgentToolModelOutput`. Return `undefined` to fall through to `tools`
   * or the default JSON projection.
   */
  resolveToolModelOutput?(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly outcome: 'success' | 'error' | 'interrupted';
  }): AgentToolModelOutput | undefined | Promise<AgentToolModelOutput | undefined>;
  /**
   * What to send when a file part has no resolver. Default `omit`.
   *
   * `text` renders a describing placeholder — filename or media type — never
   * the storage reference: that string is an address inside the application's
   * infrastructure and this content travels to the model provider.
   */
  unresolvedFile?: 'text' | 'omit' | 'error';
  leadingAssistant?: 'omit' | 'allow' | 'error';
  incompleteToolTurn?: 'omit' | 'error';
  /**
   * How an assistant turn that ended `interrupted` reaches the model. Default
   * `assistant-marked`.
   *
   * There is deliberately no setting that reproduces what this used to do,
   * which was to project the partial text as an ordinary assistant turn and
   * drop its `control` marker on the way. That is not a compatibility mode, it
   * is the defect: the model received a confident half-sentence with nothing to
   * mark it as cut off, and continued a thought the user had already redirected.
   *
   * - `assistant-marked` — the partial stays an assistant turn and says it was
   *   cut off. Right for the case `interrupted` describes today: the user
   *   pressed stop, the text was streamed to their screen, they read it. The
   *   assistant turn is the truthful record of what the human saw.
   * - `system-note` — the partial is rendered as a system line instead. An
   *   assistant turn in provider history is a *commitment*: the model reads its
   *   own previous turn as something it said and stays consistent with it. When
   *   the fragment reached nobody, consistency with it is the last thing
   *   wanted, and a system line is context rather than commitment.
   * - `omit` — the partial does not reach the model at all.
   *
   * A run ended under `inputPolicy: 'supersede'` never reaches this setting.
   * Its assistant is `superseded`, and superseded output is always omitted.
   */
  interruptedAssistant?: 'assistant-marked' | 'system-note' | 'omit';
}

export interface AgentHistoryProjectionDecision {
  messageId: string;
  action: 'projected' | 'omitted';
  reason:
    | 'projected'
    | 'draft-or-failed'
    | 'empty'
    | 'leading-assistant'
    | 'incomplete-tool-turn'
    | 'interrupted'
    | 'superseded';
  /**
   * Part types on a *projected* record that no content in the projection stands
   * for.
   *
   * Only projected records carry this. An omitted record is already accounted
   * for by its own decision; a record that reaches the model with parts quietly
   * missing is the case nothing recorded before — and a `control` marker
   * disappearing this way is what kept an interrupted answer looking complete
   * for a release.
   */
  omittedParts?: readonly HistoryPartType[];
}

export interface AgentHistoryProjectionResult {
  messages: readonly AgentModelMessage[];
  decisions: readonly AgentHistoryProjectionDecision[];
  /**
   * System and summary content, in order, for the provider's **instructions**
   * channel — never for `messages`.
   */
  system: readonly string[];
}

function unrepresented(
  parts: readonly AgentMessagePart[],
  rendered: ReadonlySet<HistoryPartType>,
): readonly HistoryPartType[] {
  const missing = new Set<HistoryPartType>();
  for (const part of parts) {
    if (!rendered.has(part.type)) missing.add(part.type);
  }
  return [...missing];
}

function decide(
  message: AgentMessage,
  action: AgentHistoryProjectionDecision['action'],
  reason: AgentHistoryProjectionDecision['reason'],
  rendered?: ReadonlySet<HistoryPartType>,
): AgentHistoryProjectionDecision {
  if (action === 'omitted' || !rendered) return { messageId: message.id, action, reason };
  const omittedParts = unrepresented(message.parts, rendered);
  return {
    messageId: message.id,
    action,
    reason,
    ...(omittedParts.length > 0 && { omittedParts }),
  };
}

function interruptedSystemNote(message: AgentMessage): {
  text?: string;
  rendered: Set<HistoryPartType>;
} {
  const rendered = new Set<HistoryPartType>();
  const text = textContent(message.parts);
  if (!text) return { rendered };
  rendered.add('text');
  rendered.add('control');
  return { text: `[interrupted] partial response: ${text}`, rendered };
}

/** Project history and retain a decision for every canonical record. */
export async function projectAgentHistoryDetailed(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<AgentHistoryProjectionResult> {
  const projected: AgentModelMessage[] = [];
  const system: string[] = [];
  const decisions: AgentHistoryProjectionDecision[] = [];
  const interruptedRule = options.interruptedAssistant ?? 'assistant-marked';
  let observedUser = false;
  let chronology = createToolChronology();
  let callInputsById = new Map<string, unknown>();
  let conversationId: string | undefined;
  for (const message of messages) {
    if (message.conversationId !== conversationId) {
      conversationId = message.conversationId;
      chronology = createToolChronology();
      callInputsById = new Map();
      observedUser = false;
    }
    // One home for "may this record still be spoken to the model", asked here,
    // by compaction, and by the token budget. Each used to answer it with its
    // own inline list, and the lists disagreed.
    if (
      message.role === 'assistant' &&
      !isAssistantHistoryEvidence(message.status, options.evidencePolicy)
    ) {
      decisions.push(
        decide(
          message,
          'omitted',
          message.status === 'superseded' ? 'superseded' : 'draft-or-failed',
        ),
      );
      continue;
    }
    if (
      message.status === 'streaming' ||
      (message.status === 'failed' &&
        options.evidencePolicy?.failedAssistant !== 'assistant-marked')
    ) {
      decisions.push(decide(message, 'omitted', 'draft-or-failed'));
      continue;
    }
    if (message.role === 'user') {
      const user = await projectUserMessage(message, options);
      // An intervening user message is not an approval cancellation. Keep any
      // unresolved request; only a settled turn can release its call identities.
      if (chronology.pending === 0) chronology = createToolChronology();
      observedUser = true;
      if (user.message) {
        projected.push(user.message);
        decisions.push(decide(message, 'projected', 'projected', user.rendered));
      } else {
        decisions.push(decide(message, 'omitted', 'empty'));
      }
      continue;
    }
    if (message.role === 'system' || message.role === 'summary') {
      const content = textContent(message.parts);
      if (content) {
        system.push(content);
        decisions.push(
          decide(message, 'projected', 'projected', new Set<HistoryPartType>(['text'])),
        );
      } else {
        decisions.push(decide(message, 'omitted', 'empty'));
      }
      continue;
    }
    if (!observedUser && options.leadingAssistant !== 'allow') {
      if (options.leadingAssistant === 'error') {
        throw new Error(`Assistant message ${message.id} precedes the first user message`);
      }
      decisions.push(decide(message, 'omitted', 'leading-assistant'));
      continue;
    }
    const interrupted = message.status === 'interrupted';
    if (interrupted && interruptedRule === 'omit') {
      decisions.push(decide(message, 'omitted', 'interrupted'));
      continue;
    }
    if (interrupted && interruptedRule === 'system-note') {
      // The chronology check below guards tool calls the provider would have to
      // pair; a system note emits none, so a half-finished tool turn is no
      // reason to drop the text with it.
      const note = interruptedSystemNote(message);
      if (note.text) {
        system.push(note.text);
        decisions.push(decide(message, 'projected', 'projected', note.rendered));
      } else {
        decisions.push(decide(message, 'omitted', 'empty'));
      }
      continue;
    }
    const nextChronology = advanceToolChronology(chronology, message.parts);
    if (!nextChronology || !canProjectToolChronology(nextChronology)) {
      if (options.incompleteToolTurn === 'error') {
        throw new Error(`Assistant message ${message.id} has incomplete tool chronology`);
      }
      decisions.push(decide(message, 'omitted', 'incomplete-tool-turn'));
      continue;
    }
    const assistant = await projectAssistantMessages(
      message,
      interrupted ? 'interrupted' : message.status === 'failed' ? 'failed' : undefined,
      options,
      callInputsById,
    );
    chronology = nextChronology;
    projected.push(...assistant.messages);
    decisions.push(
      assistant.messages.length > 0
        ? decide(message, 'projected', 'projected', assistant.rendered)
        : decide(message, 'omitted', 'empty'),
    );
  }
  return { messages: projected, decisions, system };
}

/** Project canonical engine records into provider-valid model messages. */
export async function projectAgentHistory(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<AgentModelMessage[]> {
  return [...(await projectAgentHistoryDetailed(messages, options)).messages];
}
