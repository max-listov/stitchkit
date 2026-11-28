import type { AgentModelAssistantContentPart, AgentModelMessage } from '../agent-parts/model';
import type { AgentStepContentPart } from './models-driver-step';
import { envelopeToProviderOptions } from './provider-media';
import type { ConsumedStepStream } from './provider-stream-segments';
import type { StepToolExecutionResult } from './run-tool-executor';

/** Pure builder of assistant + tool messages preserving exact ordered multi-block segments. */
export function buildStepResponseMessages(
  consumed: ConsumedStepStream,
  toolExecution: StepToolExecutionResult,
): AgentModelMessage[] {
  const assistantContent: AgentModelAssistantContentPart[] = [];
  for (const segment of consumed.segments) {
    if (segment.kind === 'reasoning') {
      if (segment.text.length === 0 && segment.provider === undefined) continue;
      const options = envelopeToProviderOptions(segment.provider);
      assistantContent.push({
        type: 'reasoning',
        text: segment.text,
        ...(options && { providerOptions: options }),
      });
    } else if (segment.kind === 'text') {
      if (segment.text.length === 0 && segment.provider === undefined) continue;
      const options = envelopeToProviderOptions(segment.provider);
      assistantContent.push({
        type: 'text',
        text: segment.text,
        ...(options && { providerOptions: options }),
      });
    } else if (segment.assistantPart !== undefined) {
      assistantContent.push(segment.assistantPart);
    }
  }
  assistantContent.push(...toolExecution.assistantParts);

  const stepResponseMessages: AgentModelMessage[] = [];
  if (assistantContent.length > 0) {
    stepResponseMessages.push({ role: 'assistant', content: assistantContent });
  }
  if (toolExecution.toolParts.length > 0) {
    stepResponseMessages.push({ role: 'tool', content: toolExecution.toolParts });
  }
  return stepResponseMessages;
}

/** Pure builder of `AgentStepResult.content` preserving exact emission order without mutating `consumed`. */
export function buildStepContent(
  consumed: ConsumedStepStream,
  toolExecution: StepToolExecutionResult,
): AgentStepContentPart[] {
  const content: AgentStepContentPart[] = [];
  for (const segment of consumed.segments) {
    if (segment.kind === 'reasoning') {
      if (segment.text.length > 0 || segment.provider !== undefined) {
        content.push({ type: 'reasoning', text: segment.text });
      }
    } else if (segment.kind === 'text') {
      if (segment.text.length > 0) {
        content.push({ type: 'text', text: segment.text });
      }
    } else if (segment.stepPart !== undefined) {
      content.push(segment.stepPart);
    }
  }
  content.push(...toolExecution.stepContent);
  return content;
}
