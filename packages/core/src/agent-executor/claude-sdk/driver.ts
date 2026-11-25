import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { findTranscriptInput } from '../claude/transcript';
import type { AgentEngineDriver } from '../engine';
import type { PlanLimits } from '../hello';
import { validateImageOptions } from '../image-input';
import { engineProfile } from '../profile';
import { openClaudeSdkSession } from './session';

/** What the leaf uses of a running query; the SDK's `Query` is one. */
export interface ClaudeSdkRun extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close?(): void;
}

/** The SDK's `query`, as the application imported it: the leaf never imports the SDK itself. */
export type ClaudeSdkQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeSdkRun;

/** Configuration for {@link createClaudeSdkDriver}. */
export interface ClaudeSdkDriverConfig {
  /** `query` from `@anthropic-ai/claude-agent-sdk`, the version the application chose. */
  query: ClaudeSdkQuery;
  /** That SDK's version, reported in `hello`. */
  sdkVersion: string;
  model?: string;
  /** Default `default`: every tool the profile does not allow is asked of `canUseTool`. */
  permissionMode?: NonNullable<Options['permissionMode']>;
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number;
  ambient?: Readonly<Record<string, string | undefined>>;
}

/**
 * Claude through the Agent SDK: the same records as the CLI, read by the
 * same classifier, with permission requests through `canUseTool` and an
 * interrupt through `Query.interrupt()`. A query that breaks fails its turn;
 * the next turn opens a new query that resumes the session.
 */
export function createClaudeSdkDriver(config: ClaudeSdkDriverConfig): AgentEngineDriver {
  validateImageOptions(config);
  const limits = new Map<string, PlanLimits>();
  return {
    engine: 'claude-sdk',
    reconcile: 'client-id',
    async info() {
      return {
        engine: 'claude-sdk',
        version: config.sdkVersion,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
      };
    },
    async status(rawProfile) {
      const profile = engineProfile('claude-sdk', rawProfile);
      const known = limits.get(profile.profileId);
      return {
        login: { state: 'unknown' },
        effectiveCredential: 'unknown',
        ...(known && { planLimits: known }),
      };
    },
    findInput: (input) => findTranscriptInput('claude-sdk', input),
    open: (input) => openClaudeSdkSession(config, limits, input),
  };
}
