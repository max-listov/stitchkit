import type { AgentCacheControl } from '../agent-parts/model';

/** Hard provider limit for explicit prompt-cache breakpoints on Anthropic / Bedrock / OpenRouter. */
export const MAX_CACHE_BREAKPOINTS = 4;

export type CacheBreakpointSlot = 'tools' | 'system' | 'message';

export interface PlannedCacheBreakpoint<TTarget> {
  readonly slot: CacheBreakpointSlot;
  readonly control: AgentCacheControl;
  readonly target: TTarget;
}

/**
 * Determine whether automatic inline `cache_control` breakpoints are beneficial for
 * an OpenRouter model slug.
 *
 * Anthropic and Qwen honor inline breakpoints; Gemini implicit caching is harmed by
 * moving tail breakpoints (each step writes a new cache entry at higher cost).
 */
export function openRouterAllowsInlineCacheControl(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('google/') || lower.includes('gemini')) return false;
  return true;
}

/** Wire representation of a portable `AgentCacheControl`. */
export function toWireCacheControl(control: AgentCacheControl): Record<string, string> {
  return {
    type: control.type,
    ...(control.ttl !== undefined && { ttl: control.ttl }),
  };
}

/**
 * Validate Anthropic TTL ordering across explicit breakpoints: any `1h` breakpoint must
 * precede every `5m` (default) breakpoint, otherwise Anthropic rejects with HTTP 400.
 */
export function assertValidCacheTtlOrder(
  controls: readonly AgentCacheControl[],
  providerName: string,
): void {
  let sawShort = false;
  for (const control of controls) {
    const ttl = control.ttl ?? '5m';
    if (ttl === '5m') {
      sawShort = true;
    } else if (sawShort) {
      throw new TypeError(
        `${providerName}: cacheControl ttl "1h" cannot appear after a shorter "5m" breakpoint`,
      );
    }
  }
}

/**
 * Cap explicit cache breakpoints to `MAX_CACHE_BREAKPOINTS` (4), preserving priority
 * order `tools → system → messages` (keeping the latest message breakpoints when trimming).
 */
export function budgetCacheBreakpoints<TTarget>(
  planned: readonly PlannedCacheBreakpoint<TTarget>[],
  limit = MAX_CACHE_BREAKPOINTS,
): PlannedCacheBreakpoint<TTarget>[] {
  if (planned.length <= limit) return [...planned];
  const tools = planned.filter((item) => item.slot === 'tools');
  const systems = planned.filter((item) => item.slot === 'system');
  const messages = planned.filter((item) => item.slot === 'message');
  const kept: PlannedCacheBreakpoint<TTarget>[] = [];

  if (tools.length > 0 && limit > 0) {
    kept.push(...tools.slice(-limit));
  }
  const remainingSystems = limit - kept.length;
  if (remainingSystems > 0 && systems.length > 0) {
    kept.push(...systems.slice(-remainingSystems));
  }
  const remainingMessages = limit - kept.length;
  if (remainingMessages > 0 && messages.length > 0) {
    kept.push(...messages.slice(-remainingMessages));
  }
  return kept;
}
