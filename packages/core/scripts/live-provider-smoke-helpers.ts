import { deflateSync } from 'node:zlib';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentUsage,
} from '../src/entrypoints/agent-runtime';

export type ProviderTarget = 'openrouter' | 'openai' | 'anthropic';
export type ScenarioProviderLabel = ProviderTarget | 'cross-driver';
export type ModelFamily = 'openai' | 'anthropic' | 'gemini';
export type ScenarioOutcomeStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface ScenarioMetrics {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly costUsd: number | undefined;
  readonly costProvenance: 'provider-reported' | 'computed' | 'estimated' | 'unavailable';
}

export interface ScenarioResult {
  readonly provider: ScenarioProviderLabel;
  readonly model: string;
  readonly scenario: string;
  readonly status: ScenarioOutcomeStatus;
  readonly durationMs: number;
  readonly metrics: ScenarioMetrics;
  readonly detail: string;
}

export interface ModelScenarioSpec {
  readonly provider: ProviderTarget;
  readonly family: ModelFamily;
  readonly modelId: string;
  readonly driver: AgentModelDriver;
  readonly isDirectAnthropic?: boolean;
  readonly standardProviderOptions?: AgentModelProviderOptions;
  readonly reasoningProviderOptions: AgentModelProviderOptions;
  readonly reasoningMaxOutputTokens: number;
  readonly cacheProviderOptions: (cacheKey: string) => AgentModelProviderOptions | undefined;
  readonly secretKeys: readonly string[];
}

export interface ScenarioExecution {
  readonly metrics: ScenarioMetrics;
  readonly detail: string;
}

export const SCENARIO_TIMEOUT_MS = 45_000;
export const STANDARD_MAX_OUTPUT_TOKENS = 512;
export const COMPACT_MAX_OUTPUT_TOKENS = 256;

export function emptyMetrics(): ScenarioMetrics {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
    costUsd: undefined,
    costProvenance: 'unavailable',
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function pauseMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Scenario aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Scenario aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function secretFragments(secretKeys: readonly string[]): string[] {
  const fragments: string[] = [];
  for (const key of secretKeys) {
    if (key.length === 0) continue;
    fragments.push(key);
    if (key.length >= 24) {
      fragments.push(key.slice(-12), key.slice(10, 22));
    }
  }
  return fragments;
}

export function scrubSecrets(text: string, secretKeys: readonly string[]): string {
  let cleaned = text;
  for (const fragment of secretFragments(secretKeys)) {
    if (fragment.length > 0 && cleaned.includes(fragment)) {
      cleaned = cleaned.split(fragment).join('[REDACTED]');
    }
  }
  return cleaned;
}

export function assertNoKeyLeak(
  text: string,
  secretKeys: readonly string[],
  fieldName: string,
): void {
  for (const fragment of secretFragments(secretKeys)) {
    if (fragment.length > 0 && text.includes(fragment)) {
      throw new Error(`Secret API key material leaked inside ${fieldName}`);
    }
  }
}

function readUsageInt(entry: AgentUsage['inputTokens'] | undefined): number | undefined {
  if (!entry || entry.provenance === 'unavailable') return undefined;
  return entry.value;
}

export function extractMetrics(usage: AgentUsage): ScenarioMetrics {
  const cost = usage.cost;
  const hasCost =
    cost !== undefined && cost.provenance !== 'unavailable' && cost.value !== undefined;
  return {
    inputTokens: readUsageInt(usage.inputTokens),
    outputTokens: readUsageInt(usage.outputTokens),
    cacheReadTokens: readUsageInt(usage.cacheReadTokens),
    cacheWriteTokens: readUsageInt(usage.cacheWriteTokens),
    reasoningTokens: readUsageInt(usage.reasoningTokens),
    costUsd: hasCost ? cost.value : undefined,
    costProvenance: hasCost ? cost.provenance : 'unavailable',
  };
}

function sumOptional(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value !== undefined) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

export function mergeMetrics(list: readonly ScenarioMetrics[]): ScenarioMetrics {
  const costUsd = sumOptional(list.map((entry) => entry.costUsd));
  const sawMeasuredCost = list.some((entry) => entry.costUsd !== undefined);
  return {
    inputTokens: sumOptional(list.map((entry) => entry.inputTokens)),
    outputTokens: sumOptional(list.map((entry) => entry.outputTokens)),
    cacheReadTokens: sumOptional(list.map((entry) => entry.cacheReadTokens)),
    cacheWriteTokens: sumOptional(list.map((entry) => entry.cacheWriteTokens)),
    reasoningTokens: sumOptional(list.map((entry) => entry.reasoningTokens)),
    costUsd,
    costProvenance: sawMeasuredCost ? 'computed' : 'unavailable',
  };
}

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32Be(chunk, 0, data.length);
  for (let i = 0; i < 4; i += 1) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = computeCrc32(chunk.subarray(4, 8 + data.length));
  writeUint32Be(chunk, 8 + data.length, crc);
  return chunk;
}

/** Generate a valid standards-compliant RGB PNG byte buffer programmatically. */
export function createSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Uint8Array<ArrayBuffer> {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  writeUint32Be(ihdr, 0, width);
  writeUint32Be(ihdr, 4, height);
  ihdr[8] = 8; // 8-bit channel depth
  ihdr[9] = 2; // RGB truecolor
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * stride;
    raw[rowStart] = 0; // filter type None
    for (let col = 0; col < width; col += 1) {
      const px = rowStart + 1 + col * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = pngChunk('IDAT', new Uint8Array(deflateSync(raw)));
  const iend = pngChunk('IEND', new Uint8Array(0));
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const out = new Uint8Array(signature.length + ihdrChunk.length + idat.length + iend.length);
  let cursor = 0;
  for (const part of [signature, ihdrChunk, idat, iend]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export const RED_PNG = createSolidPng(16, 16, 220, 20, 20);
export const BLUE_PNG = createSolidPng(16, 16, 20, 40, 220);

const DOMAINS = [
  'ingress-gateway',
  'contract-router',
  'stream-multiplexer',
  'schema-validator',
  'token-accounting',
  'retry-scheduler',
  'checkpoint-ledger',
  'tool-dispatcher',
  'cache-coordinator',
  'artifact-registry',
  'session-broker',
  'deadline-arbiter',
] as const;

const POLICIES = [
  'strict schema validation prior to side-effect execution',
  'bounded memory buffers with deterministic backpressure signals',
  'explicit provenance tracking that preserves unavailable measurements',
  'idempotent replay tokens anchored to immutable step identifiers',
  'per-call abort propagation with monotonic wall-clock deadlines',
  'header redaction across transport errors and diagnostic journals',
  'ordered content preservation across multi-turn reasoning exchanges',
] as const;

/**
 * Build a deterministic ~5,000-token structured handbook exceeding OpenAI (1,024),
 * Gemini (1,024-2,048), and Claude Haiku 4.5 (4,096) minimum cache thresholds.
 */
export function buildStaticCacheHandbook(nonce: string): string {
  const lines: string[] = [
    `# Distributed Runtime Operations Reference (Edition ${nonce})`,
    'Answer lookup questions concisely using only the exact section reference code.',
    '',
  ];
  for (let index = 1; index <= 44; index += 1) {
    const num = String(index).padStart(2, '0');
    const code = `CODE-${8400 + index}`;
    const domain = DOMAINS[(index * 5) % DOMAINS.length] ?? DOMAINS[0];
    const policy = POLICIES[(index * 3) % POLICIES.length] ?? POLICIES[0];
    const timeoutSec = 15 + ((index * 7) % 45);
    const maxBatch = 8 + ((index * 11) % 56);
    lines.push(
      `## Section ${num} — ${domain} (${code})`,
      `Primary directive for ${domain} under revision ${num}: enforce ${policy}. ` +
        `Operators inspecting section ${num} must verify that outbound requests keep a hard ` +
        `${timeoutSec}-second transport budget, cap parallel fan-out at ${maxBatch} items, ` +
        'and emit structured telemetry with integer token totals rather than synthetic zeros. ' +
        `When downstream validation refuses a payload in ${domain}, classify the fault using ` +
        `the canonical machine code before selecting retry or escalation. Reference token: ${code}.`,
      '',
    );
  }
  return lines.join('\n');
}

export function inspectReasoningArtifacts(
  step:
    | {
        readonly response: { readonly messages: readonly AgentModelMessage[] };
        readonly usage?: AgentUsage;
      }
    | undefined,
  provider: ProviderTarget,
  totalUsage?: AgentUsage,
): { readonly ok: boolean; readonly tag: string } {
  if (!step) return { ok: false, tag: 'no-step-0' };
  let sawOpenAiEncrypted = false;
  let sawAnthropicSig = false;
  let sawOpenRouterDetails = false;
  let sawToolExtraContent = false;
  for (const msg of step.response.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'reasoning' && isPlainRecord(part.providerOptions)) {
        const oa = part.providerOptions.openai;
        if (
          isPlainRecord(oa) &&
          typeof oa.encrypted_content === 'string' &&
          oa.encrypted_content.length > 0
        ) {
          sawOpenAiEncrypted = true;
        }
        const anth = part.providerOptions.anthropic;
        const hasSig =
          isPlainRecord(anth) &&
          ((typeof anth.signature === 'string' && anth.signature.length > 0) ||
            (anth.type === 'redacted_thinking' &&
              typeof anth.data === 'string' &&
              anth.data.length > 0));
        if (hasSig) sawAnthropicSig = true;
        const or = part.providerOptions.openrouter;
        if (
          isPlainRecord(or) &&
          Array.isArray(or.reasoning_details) &&
          or.reasoning_details.length > 0
        ) {
          sawOpenRouterDetails = true;
        }
      }
      if (part.type === 'tool-call' && isPlainRecord(part.providerOptions)) {
        const or = part.providerOptions.openrouter;
        if (isPlainRecord(or) && isPlainRecord(or.extra_content)) {
          sawToolExtraContent = true;
        }
      }
    }
  }
  if (provider === 'openai') {
    return {
      ok: sawOpenAiEncrypted,
      tag: sawOpenAiEncrypted ? 'encrypted_content=ok' : 'encrypted_content=absent',
    };
  }
  if (provider === 'anthropic') {
    return {
      ok: sawAnthropicSig,
      tag: sawAnthropicSig ? 'signature=ok' : 'signature=absent',
    };
  }
  const reasoningTokens =
    readUsageInt(step.usage?.reasoningTokens) ?? readUsageInt(totalUsage?.reasoningTokens);
  const hasRoundTripArtifacts = sawOpenRouterDetails || sawToolExtraContent;
  const tags: string[] = [];
  if (sawOpenRouterDetails) tags.push('reasoning_details=ok');
  if (sawToolExtraContent) tags.push('extra_content=ok');
  if (!hasRoundTripArtifacts) tags.push('reasoning_artifacts=absent');
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    tags.push(`reasoningTokens=${reasoningTokens}`);
  }
  return { ok: hasRoundTripArtifacts, tag: tags.join(',') };
}

export async function runTimedScenario(
  input: {
    readonly provider: ScenarioProviderLabel;
    readonly model: string;
    readonly scenario: string;
    readonly secretKeys: readonly string[];
  },
  fn: (signal: AbortSignal) => Promise<ScenarioExecution>,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(SCENARIO_TIMEOUT_MS);
  try {
    const outcome = await fn(signal);
    const durationMs = Math.round(performance.now() - startedAt);
    const detail = scrubSecrets(outcome.detail, input.secretKeys);
    console.log(
      `[PASS] ${input.provider}/${input.model} :: ${input.scenario} (${durationMs}ms) ${detail}`,
    );
    return { ...input, status: 'PASS', durationMs, metrics: outcome.metrics, detail };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const rawMsg = error instanceof Error ? error.message : String(error);
    const detail = scrubSecrets(rawMsg, input.secretKeys).slice(0, 220);
    console.log(
      `[FAIL] ${input.provider}/${input.model} :: ${input.scenario} (${durationMs}ms) ${detail}`,
    );
    return { ...input, status: 'FAIL', durationMs, metrics: emptyMetrics(), detail };
  }
}
