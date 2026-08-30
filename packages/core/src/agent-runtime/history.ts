import { type FilePart, type ModelMessage, modelMessageSchema } from 'ai';
import { modelMessageWithApprovalSignature } from '../internal/ai-sdk-typed';
import {
  advanceToolChronology,
  canProjectToolChronology,
  createToolChronology,
} from './history-chronology';
import type { AgentMessage, AgentMessagePart, AgentProviderEnvelope } from './schemas';
import {
  type AgentHistoryEvidencePolicy,
  isAssistantHistoryEvidence,
} from './terminal-status';

type PartType = AgentMessagePart['type'];

export interface AgentHistoryProjectionOptions {
  evidencePolicy?: AgentHistoryEvidencePolicy;
  resolveFile?(
    part: Extract<AgentMessagePart, { type: 'file' }>,
    message: AgentMessage,
  ): FilePart['data'] | Promise<FilePart['data']>;
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
  omittedParts?: readonly PartType[];
}

export interface AgentHistoryProjectionResult {
  messages: readonly ModelMessage[];
  decisions: readonly AgentHistoryProjectionDecision[];
  /**
   * System and summary content, in order, for the provider's **instructions**
   * channel — never for `messages`.
   *
   * `ai` refuses a system-role entry inside `messages` outright: *"System
   * messages are not allowed in the prompt or messages fields. Use the
   * instructions option instead."* This projection used to put them there, so a
   * conversation that had ever been compacted failed **every** subsequent run
   * with `provider_failure`, and the `system-note` form of an interrupted turn
   * did the same. Both shipped, and the whole suite stayed green because the
   * tests asserted the projection's *shape* and never handed it to a provider.
   */
  system: readonly string[];
}

function providerOptions(envelope: AgentProviderEnvelope | undefined) {
  if (!envelope) return undefined;
  return envelope.provider === 'ai-sdk'
    ? envelope.data
    : { [envelope.provider]: envelope.data };
}

function textContent(parts: readonly AgentMessagePart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function unrepresented(
  parts: readonly AgentMessagePart[],
  rendered: ReadonlySet<PartType>,
): readonly PartType[] {
  const missing = new Set<PartType>();
  for (const part of parts) {
    if (!rendered.has(part.type)) missing.add(part.type);
  }
  return [...missing];
}

function decide(
  message: AgentMessage,
  action: AgentHistoryProjectionDecision['action'],
  reason: AgentHistoryProjectionDecision['reason'],
  rendered?: ReadonlySet<PartType>,
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

/**
 * What an interrupted turn says about itself.
 *
 * Driven by the message *status*, not by the presence of a `control` part: the
 * abort path that does not throw commits an interrupted assistant without one,
 * so a marker conditioned on the part would be missing from exactly the runs a
 * newer input ended.
 */
const INTERRUPTION_NOTE = '[interrupted: this turn was cut off before it finished]';
const FAILURE_NOTE =
  '[failed: partial evidence from a run that did not complete successfully]';

async function userMessage(
  message: AgentMessage,
  options: AgentHistoryProjectionOptions,
): Promise<{ message?: ModelMessage; rendered: Set<PartType> }> {
  const rendered = new Set<PartType>();
  const text = textContent(message.parts);
  const content: unknown[] = [];
  if (text) {
    content.push({ type: 'text', text });
    rendered.add('text');
  }
  for (const part of message.parts) {
    if (part.type !== 'file') continue;
    if (options.resolveFile) {
      content.push({
        type: 'file',
        data: await options.resolveFile(part, message),
        mediaType: part.mediaType,
        ...(part.filename && { filename: part.filename }),
      });
      rendered.add('file');
      continue;
    }
    const fallback = options.unresolvedFile ?? 'omit';
    if (fallback === 'error') {
      // Thrown into the application's own process, so it names the reference:
      // inward we owe the operator everything. The provider never sees it.
      throw new Error(`No history file resolver configured for ${part.reference}`);
    }
    if (fallback === 'text') {
      // `part.reference` is an address in the application's storage — an object
      // key or a path. It identifies our infrastructure, and this string is
      // sent upstream, so the placeholder describes the attachment instead.
      const described = part.filename ?? part.mediaType;
      content.push({
        type: 'text',
        text: described ? `[attachment: ${described}]` : '[attachment]',
      });
      rendered.add('file');
    }
  }
  if (content.length === 0) return { rendered };
  return { message: modelMessageSchema.parse({ role: 'user', content }), rendered };
}

function assistantMessages(
  message: AgentMessage,
  marker: 'interrupted' | 'failed' | undefined,
): { messages: ModelMessage[]; rendered: Set<PartType> } {
  const rendered = new Set<PartType>();
  const messages: ModelMessage[] = [];
  let role: 'assistant' | 'tool' | undefined;
  let content: unknown[] = [];
  const flush = (): void => {
    if (!role || content.length === 0) return;
    messages.push(modelMessageWithApprovalSignature({ role, content }));
    content = [];
  };
  const append = (nextRole: 'assistant' | 'tool', part: unknown): void => {
    if (role !== nextRole) {
      flush();
      role = nextRole;
    }
    content.push(part);
  };
  for (const part of message.parts) {
    if (part.type === 'text') {
      append('assistant', { type: 'text', text: part.text });
      rendered.add('text');
    }
    if (part.type === 'reasoning') {
      append('assistant', {
        type: 'reasoning',
        text: part.text,
        ...(part.provider && { providerOptions: providerOptions(part.provider) }),
      });
      rendered.add('reasoning');
    }
    if (part.type === 'tool-call') {
      append('assistant', {
        type: 'tool-call',
        toolCallId: part.callId,
        toolName: part.toolName,
        input: part.input,
        ...(part.provider && { providerOptions: providerOptions(part.provider) }),
      });
      rendered.add('tool-call');
    }
    if (part.type === 'tool-result') {
      const output =
        part.outcome === 'success'
          ? { type: 'json', value: part.output ?? null }
          : { type: 'error-json', value: part.output ?? { message: part.outcome } };
      append('tool', {
        type: 'tool-result',
        toolCallId: part.callId,
        toolName: part.toolName,
        output,
      });
      rendered.add('tool-result');
    }
    if (part.type === 'tool-approval-request') {
      append('assistant', {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.callId,
        ...(part.isAutomatic !== undefined && { isAutomatic: part.isAutomatic }),
        ...(part.signature && { signature: part.signature }),
      });
      rendered.add('tool-approval-request');
    }
    if (part.type === 'tool-approval-response') {
      append('tool', {
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason && { reason: part.reason }),
      });
      rendered.add('tool-approval-response');
    }
  }
  if (marker && (messages.length > 0 || content.length > 0)) {
    append('assistant', {
      type: 'text',
      text: marker === 'interrupted' ? INTERRUPTION_NOTE : FAILURE_NOTE,
    });
    // The note stands for the marker, so a `control` part is now represented
    // rather than silently dropped.
    rendered.add('control');
  }
  flush();
  return { messages, rendered };
}

function interruptedSystemNote(message: AgentMessage): {
  text?: string;
  rendered: Set<PartType>;
} {
  const rendered = new Set<PartType>();
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
  const projected: ModelMessage[] = [];
  const system: string[] = [];
  const decisions: AgentHistoryProjectionDecision[] = [];
  const interruptedRule = options.interruptedAssistant ?? 'assistant-marked';
  let observedUser = false;
  let chronology = createToolChronology();
  let conversationId: string | undefined;
  for (const message of messages) {
    if (message.conversationId !== conversationId) {
      conversationId = message.conversationId;
      chronology = createToolChronology();
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
      const user = await userMessage(message, options);
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
        decisions.push(decide(message, 'projected', 'projected', new Set<PartType>(['text'])));
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
    const assistant = assistantMessages(
      message,
      interrupted ? 'interrupted' : message.status === 'failed' ? 'failed' : undefined,
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

/** Project canonical engine records into provider-valid AI SDK messages. */
export async function projectAgentHistory(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<ModelMessage[]> {
  return [...(await projectAgentHistoryDetailed(messages, options)).messages];
}
