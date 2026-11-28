import type { z } from 'zod';
import type {
  AgentModelAssistantContentPart,
  AgentModelMessage,
  AgentModelToolContentPart,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type { AgentTool, AgentToolSet } from '../tools/agent-tools';
import type {
  AgentToolApprovalConfiguration,
  AgentToolApprovalDecision,
  AgentToolApprovalToolRule,
} from './models-driver-step';
import { jsonValue } from './runtime-internals';

/** Machine reason code describing why a tool-approval check or continuation failed. */
export type AgentToolApprovalErrorReason =
  | 'invalid-signature'
  | 'call-not-found'
  | 'input-validation-failed'
  | 'input-mutated'
  | 'invalid-policy-decision'
  | 'approval-unsupported';

/** Base refusal for invalid or tampered tool-approval continuation records (runtime's own input). */
export class AgentToolApprovalError extends Error {
  readonly reason: AgentToolApprovalErrorReason;

  constructor(
    message: string,
    options?: {
      readonly reason?: AgentToolApprovalErrorReason;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentToolApprovalError';
    this.reason = options?.reason ?? 'input-validation-failed';
  }
}

export class AgentInvalidToolApprovalSignatureError extends AgentToolApprovalError {
  constructor(approvalId: string, detail = 'Invalid or missing tool approval signature') {
    super(`${detail} for approval "${approvalId}"`, { reason: 'invalid-signature' });
    this.name = 'AgentInvalidToolApprovalSignatureError';
  }
}

export class AgentToolCallNotFoundForApprovalError extends AgentToolApprovalError {
  constructor(approvalId: string) {
    super(`Tool call not found for approval "${approvalId}"`, { reason: 'call-not-found' });
    this.name = 'AgentToolCallNotFoundForApprovalError';
  }
}

const encoder = new TextEncoder();

/** Refuse an empty or non-byte/non-string `loop.toolApprovalSecret` before any signing happens. */
export function assertToolApprovalSecret(secret: string | Uint8Array | undefined): void {
  if (secret === undefined) return;
  if (typeof secret === 'string') {
    if (secret.length === 0) {
      throw new TypeError('loop.toolApprovalSecret must not be empty');
    }
    return;
  }
  if (secret instanceof Uint8Array) {
    if (secret.byteLength === 0) {
      throw new TypeError('loop.toolApprovalSecret must not be empty');
    }
    return;
  }
  throw new TypeError('loop.toolApprovalSecret must be a non-empty string or Uint8Array');
}

/** Normalize a parsed tool input into the exact JSON value persisted in `tool-call` and signed in HMACs. */
export function normalizePersistedToolInput(
  value: unknown,
): z.infer<ReturnType<typeof z.json>> {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return jsonValue(JSON.parse(serialized));
  } catch {
    // Fall through to jsonValue for non-JSON values (e.g. BigInt, circular references).
  }
  return jsonValue(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(encoded: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  const padded = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + '='.repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic JSON serialization byte-compatible with AI SDK tool-approval HMACs:
 * object keys are sorted and keys whose value is `undefined` are retained as `"k":undefined`,
 * while array elements equal to `undefined` serialize as `null`.
 */
export function canonicalApprovalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'null' : JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalApprovalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalApprovalJson(Reflect.get(value, key))}`).join(',')}}`;
}

function comparableApprovalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return canonicalApprovalJson(JSON.parse(serialized));
  } catch {
    // Fall back to direct canonicalApprovalJson for values JSON.stringify cannot handle.
  }
  return canonicalApprovalJson(value);
}

async function importHmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  assertToolApprovalSecret(secret);
  const raw = typeof secret === 'string' ? encoder.encode(secret) : secret;
  const keyBytes = new Uint8Array(raw.byteLength);
  keyBytes.set(raw);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function inputDigest(input: unknown): Promise<string> {
  const encoded = input === undefined ? '' : canonicalApprovalJson(input);
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(encoded));
  return bytesToBase64Url(new Uint8Array(hash));
}

function v1Payload(
  approvalId: string,
  toolCallId: string,
  toolName: string,
  digest: string,
): Uint8Array {
  return encoder.encode(
    JSON.stringify(['ai-sdk-tool-approval-v1', approvalId, toolCallId, toolName, digest]),
  );
}

function legacyPayload(
  approvalId: string,
  toolCallId: string,
  toolName: string,
  digest: string,
): Uint8Array | undefined {
  if (approvalId.includes('\n') || toolCallId.includes('\n') || toolName.includes('\n')) {
    return undefined;
  }
  return encoder.encode(`${approvalId}\n${toolCallId}\n${toolName}\n${digest}`);
}

/** Sign one tool-approval request with WebCrypto HMAC-SHA256 (byte-compatible with AI SDK v1). */
export async function signToolApproval(input: {
  secret: string | Uint8Array;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<string> {
  const [key, digest] = await Promise.all([
    importHmacKey(input.secret),
    inputDigest(input.toolInput),
  ]);
  const payload = v1Payload(input.approvalId, input.toolCallId, input.toolName, digest);
  const signature = await crypto.subtle.sign('HMAC', key, new Uint8Array(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Verify one tool-approval signature via constant-time `crypto.subtle.verify` (v1 + legacy). */
export async function verifyToolApprovalSignature(input: {
  secret: string | Uint8Array;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  signature: string | undefined;
}): Promise<boolean> {
  if (!input.signature) return false;
  const sigBytes = base64UrlToBytes(input.signature);
  if (!sigBytes) return false;
  const [key, digest] = await Promise.all([
    importHmacKey(input.secret),
    inputDigest(input.toolInput),
  ]);
  const sigCopy = new Uint8Array(sigBytes.byteLength);
  sigCopy.set(sigBytes);
  const primary = v1Payload(input.approvalId, input.toolCallId, input.toolName, digest);
  if (await crypto.subtle.verify('HMAC', key, sigCopy, new Uint8Array(primary))) return true;
  const legacy = legacyPayload(input.approvalId, input.toolCallId, input.toolName, digest);
  if (!legacy) return false;
  return crypto.subtle.verify('HMAC', key, sigCopy, new Uint8Array(legacy));
}

export interface NormalizedApprovalOutcome {
  readonly kind: 'execute' | 'approved' | 'denied' | 'user-approval';
  readonly reason?: string;
}

const APPROVAL_DECISION_TYPES = new Set<string>([
  'approved',
  'denied',
  'user-approval',
  'not-applicable',
]);

function isApprovalDecisionType(
  value: unknown,
): value is 'approved' | 'denied' | 'user-approval' | 'not-applicable' {
  return typeof value === 'string' && APPROVAL_DECISION_TYPES.has(value);
}

function normalizePolicyDecision(
  raw: unknown,
  toolName: string,
): {
  readonly type: 'approved' | 'denied' | 'user-approval' | 'not-applicable';
  readonly reason?: string;
} {
  if (raw === undefined) return { type: 'not-applicable' };
  if (isApprovalDecisionType(raw)) return { type: raw };
  if (
    isRecord(raw) &&
    isApprovalDecisionType(raw.type) &&
    (raw.reason === undefined || typeof raw.reason === 'string')
  ) {
    return { type: raw.type, ...(raw.reason !== undefined && { reason: raw.reason }) };
  }
  throw new AgentToolApprovalError(
    `Invalid tool approval policy decision for tool "${toolName}"`,
    { reason: 'invalid-policy-decision' },
  );
}

/** Evaluate `loop.toolApproval` (function or map) and fallback `tool.needsApproval`. */
export async function evaluateToolApprovalPolicy<TOOLS extends AgentToolSet, CONTEXT>(input: {
  tool: AgentTool;
  toolName: string;
  toolCallId: string;
  toolInput: unknown;
  providerExecuted?: boolean;
  messages: readonly AgentModelMessage[];
  abortSignal?: AbortSignal;
  runtimeContext: CONTEXT;
  toolApproval: AgentToolApprovalConfiguration<TOOLS, CONTEXT> | undefined;
}): Promise<NormalizedApprovalOutcome> {
  if (input.toolApproval !== undefined) {
    let raw: AgentToolApprovalDecision | undefined;
    if (typeof input.toolApproval === 'function') {
      raw = await input.toolApproval({
        toolCall: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.toolInput,
          ...(input.providerExecuted !== undefined && {
            providerExecuted: input.providerExecuted,
          }),
        },
        messages: input.messages,
        runtimeContext: input.runtimeContext,
      });
    } else if (Object.hasOwn(input.toolApproval, input.toolName)) {
      const rules: Readonly<
        Record<string, AgentToolApprovalToolRule<CONTEXT, unknown> | undefined>
      > = input.toolApproval;
      const rule = rules[input.toolName];
      if (typeof rule === 'function') {
        raw = await rule(input.toolInput, {
          toolCallId: input.toolCallId,
          messages: input.messages,
          runtimeContext: input.runtimeContext,
        });
      } else if (rule !== undefined) {
        raw = rule;
      }
    }
    const normalized = normalizePolicyDecision(raw, input.toolName);
    if (normalized.type !== 'not-applicable') {
      return {
        kind: normalized.type,
        ...(normalized.reason !== undefined && { reason: normalized.reason }),
      };
    }
  }
  const needs = input.tool.needsApproval;
  if (needs !== undefined) {
    const required =
      typeof needs === 'function'
        ? await needs.call(input.tool, input.toolInput, {
            toolCallId: input.toolCallId,
            messages: input.messages,
            abortSignal: input.abortSignal,
          })
        : needs;
    if (required) return { kind: 'user-approval' };
  }
  return { kind: 'execute' };
}

export interface PendingApprovalContinuation {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly approved: boolean;
  readonly reason?: string;
}

/**
 * Inspect the tail `role: 'tool'` message for unresolved `tool-approval-response` entries,
 * verify each against its matching `tool-approval-request`, signature and `tool-call`, and
 * return them in the assistant's original tool-call order.
 */
export async function collectApprovalContinuations(input: {
  messages: readonly AgentModelMessage[];
  tools: AgentToolSet;
  secret: string | Uint8Array | undefined;
}): Promise<PendingApprovalContinuation[]> {
  const last = input.messages.at(-1);
  if (last?.role !== 'tool') return [];
  const responses: Extract<AgentModelToolContentPart, { type: 'tool-approval-response' }>[] =
    [];
  const seenApprovalIds = new Set<string>();
  for (const part of last.content) {
    if (part.type === 'tool-approval-response' && part.providerExecuted !== true) {
      if (seenApprovalIds.has(part.approvalId)) continue;
      seenApprovalIds.add(part.approvalId);
      responses.push(part);
    }
  }
  if (responses.length === 0) return [];

  // Scan ALL tool messages in history so previously settled calls are never re-executed.
  const alreadySettledCalls = new Set<string>();
  for (const message of input.messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        alreadySettledCalls.add(part.toolCallId);
      }
    }
  }

  // Index every assistant tool-call and tool-approval-request across history.
  const callsById = new Map<
    string,
    { part: Extract<AgentModelAssistantContentPart, { type: 'tool-call' }>; order: number }
  >();
  const requestsByApprovalId = new Map<
    string,
    Extract<AgentModelAssistantContentPart, { type: 'tool-approval-request' }>
  >();
  let order = 0;
  for (const message of input.messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        callsById.set(part.toolCallId, { part, order });
        order += 1;
      } else if (part.type === 'tool-approval-request') {
        requestsByApprovalId.set(part.approvalId, part);
      }
    }
  }

  const seenToolCallIds = new Set<string>();
  const resolved: { item: PendingApprovalContinuation; order: number }[] = [];
  for (const response of responses) {
    const request = requestsByApprovalId.get(response.approvalId);
    if (!request) {
      throw new AgentToolCallNotFoundForApprovalError(response.approvalId);
    }
    const callEntry = callsById.get(request.toolCallId);
    if (!callEntry) {
      throw new AgentToolCallNotFoundForApprovalError(response.approvalId);
    }
    if (
      alreadySettledCalls.has(callEntry.part.toolCallId) ||
      seenToolCallIds.has(callEntry.part.toolCallId)
    ) {
      continue;
    }
    seenToolCallIds.add(callEntry.part.toolCallId);
    if (input.secret !== undefined) {
      const valid = await verifyToolApprovalSignature({
        secret: input.secret,
        approvalId: response.approvalId,
        toolCallId: callEntry.part.toolCallId,
        toolName: callEntry.part.toolName,
        toolInput: callEntry.part.input,
        signature: request.signature,
      });
      if (!valid) {
        throw new AgentInvalidToolApprovalSignatureError(response.approvalId);
      }
    }
    let validatedInput: unknown = callEntry.part.input;
    if (response.approved) {
      const tool = Object.hasOwn(input.tools, callEntry.part.toolName)
        ? input.tools[callEntry.part.toolName]
        : undefined;
      if (tool?.parseInput) {
        let cloned: unknown;
        let parsed: Awaited<ReturnType<NonNullable<AgentTool['parseInput']>>>;
        try {
          cloned = structuredClone(callEntry.part.input);
          parsed = await tool.parseInput(cloned);
        } catch (error) {
          throw new AgentToolApprovalError(
            `Approved tool call "${callEntry.part.toolName}" failed input validation`,
            { reason: 'input-validation-failed', cause: error },
          );
        }
        if (!parsed.ok) {
          throw new AgentToolApprovalError(
            `Approved tool call "${callEntry.part.toolName}" failed input validation`,
            { reason: 'input-validation-failed', cause: parsed.error },
          );
        }
        if (
          comparableApprovalJson(parsed.value) !== comparableApprovalJson(callEntry.part.input)
        ) {
          throw new AgentToolApprovalError(
            `Approved tool call "${callEntry.part.toolName}" input changed after validation`,
            { reason: 'input-mutated' },
          );
        }
        validatedInput = parsed.value;
      }
    }
    resolved.push({
      order: callEntry.order,
      item: {
        approvalId: response.approvalId,
        toolCallId: callEntry.part.toolCallId,
        toolName: callEntry.part.toolName,
        input: validatedInput,
        approved: response.approved,
        ...(response.reason !== undefined && { reason: response.reason }),
      },
    });
  }
  resolved.sort((left, right) => left.order - right.order);
  return resolved.map((entry) => entry.item);
}
