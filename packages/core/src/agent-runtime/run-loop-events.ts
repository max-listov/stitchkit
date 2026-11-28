import type { AgentGeneratedFileData } from '../agent-parts/model';
import type { AgentProviderEnvelope, AgentSourcePart } from '../agent-parts/parts';
import type {
  AgentModelCostDetails,
  AgentModelFinishReason,
  AgentStepTimings,
} from './models-driver';
import type { AgentStepToolCall } from './models-driver-step';
import type { AgentUsage } from './schemas';

/** Internal event stream consumed by `applyStreamPart` inside the native step loop. */
export type AgentLoopEvent =
  | { readonly type: 'start-step' }
  | {
      readonly type: 'text-start';
      readonly id?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'text-delta';
      readonly id?: string;
      readonly text: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'text-end';
      readonly id?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-start';
      readonly id?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-delta';
      readonly id?: string;
      readonly text: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-end';
      readonly id?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-input-start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly providerExecuted?: boolean;
    }
  | { readonly type: 'tool-input-delta'; readonly toolCallId?: string; readonly delta: string }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: unknown;
      readonly output: unknown;
      readonly preliminary?: boolean;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-error';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: unknown;
      readonly error: unknown;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'tool-output-denied';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: unknown;
      readonly reason?: string;
    }
  | {
      readonly type: 'tool-approval-request';
      readonly approvalId: string;
      readonly toolCall: AgentStepToolCall;
      readonly isAutomatic?: boolean;
      readonly signature?: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'tool-approval-response';
      readonly approvalId: string;
      readonly approved: boolean;
      readonly reason?: string;
    }
  | { readonly type: 'source'; readonly source: AgentSourcePart }
  | {
      readonly type: 'file';
      readonly mediaType: string;
      readonly data: AgentGeneratedFileData;
      readonly filename?: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'reasoning-file';
      readonly mediaType: string;
      readonly data: AgentGeneratedFileData;
      readonly provider?: AgentProviderEnvelope;
    }
  | {
      readonly type: 'custom';
      readonly kind: string;
      readonly provider?: AgentProviderEnvelope;
    }
  | { readonly type: 'raw'; readonly rawValue: unknown }
  | { readonly type: 'abort' }
  | { readonly type: 'error'; readonly error: unknown }
  | {
      readonly type: 'finish-step';
      readonly finishReason: AgentModelFinishReason;
      readonly rawFinishReason?: string;
      readonly responseId: string;
      readonly responseModelId?: string;
      readonly responseTimestamp?: Date;
      readonly responseProvider?: string;
      readonly toolCallCount?: number;
      readonly usage: AgentUsage;
      readonly costDetails?: AgentModelCostDetails;
      readonly timings?: AgentStepTimings;
    }
  | {
      readonly type: 'finish';
      readonly finishReason: AgentModelFinishReason;
      readonly totalUsage: AgentUsage;
    };
