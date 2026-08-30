import type { AgentMessage, AgentMessagePart, AgentSnapshot } from 'stitchkit/agent-runtime';

export interface AgentTuiTranscriptEntry {
  id: string;
  role: 'you' | 'agent' | 'tool' | 'system';
  text: string;
  tone: 'primary' | 'muted' | 'success' | 'danger' | 'accent';
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}

function isToolErrorEnvelope(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof Reflect.get(value, 'error') === 'string'
  );
}

function partText(part: AgentMessagePart): { text: string; failed?: boolean } | undefined {
  if (part.type === 'text') return { text: part.text };
  if (part.type === 'reasoning') return { text: part.text };
  if (part.type === 'tool-call')
    return { text: `→ ${part.toolName} ${compactJson(part.input)}` };
  if (part.type === 'tool-result') {
    const failed = part.outcome !== 'success' || isToolErrorEnvelope(part.output);
    return {
      text: `${failed ? '×' : '✓'} ${part.toolName}${
        part.output === undefined ? '' : ` ${compactJson(part.output)}`
      }`,
      failed,
    };
  }
  if (part.type === 'tool-approval-request') return { text: 'Approval required.' };
  if (part.type === 'tool-approval-response') {
    return {
      text: part.approved ? 'Approved.' : `Denied${part.reason ? `: ${part.reason}` : '.'}`,
    };
  }
  if (part.type === 'file') return { text: `File · ${part.filename ?? part.reference}` };
  if (part.type === 'source')
    return { text: `Source · ${part.title ?? part.url ?? part.sourceId}` };
  if (part.type === 'control') return { text: `Run ${part.reason}.` };
  return undefined;
}

function role(message: AgentMessage): AgentTuiTranscriptEntry['role'] {
  if (message.role === 'user') return 'you';
  if (message.role === 'assistant') return 'agent';
  if (message.role === 'tool') return 'tool';
  return 'system';
}

export function projectAgentTuiTranscript(
  snapshot: AgentSnapshot,
): readonly AgentTuiTranscriptEntry[] {
  return snapshot.messages.flatMap((message) =>
    message.parts.flatMap((part, index) => {
      const projected = partText(part);
      if (!projected?.text.trim()) return [];
      const messageRole = role(message);
      return [
        {
          id: `${message.id}:${index}`,
          role: messageRole,
          text: projected.text,
          tone: projected.failed
            ? 'danger'
            : part.type === 'tool-result'
              ? 'success'
              : messageRole === 'you'
                ? 'accent'
                : messageRole === 'tool' || messageRole === 'system'
                  ? 'muted'
                  : 'primary',
        } satisfies AgentTuiTranscriptEntry,
      ];
    }),
  );
}
