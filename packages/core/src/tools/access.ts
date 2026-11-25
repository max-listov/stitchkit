/**
 * Mandatory access policy for every mounted tool surface.
 *
 * Every tool mount declares its `access`: `{ gate }` carries the mandatory
 * `beforeHandle` that HTTP enforces, `{ open }` a closed reason why no gate runs
 * here. An optional policy is one a mount can forget, and a forgotten gate is an
 * unauthenticated tool.
 */
import { isRecord } from '../internal/typed';
import type { ToolLifecycle } from './execute-hooks';

/** Closed vocabulary explaining why a mounted tool surface has no `beforeHandle` gate. */
export const TOOL_OPEN_REASONS = ['public', 'local-operator', 'remote'] as const;

/** Declared reason a mounted tool surface runs without a `beforeHandle` gate. */
export type ToolOpenReason = (typeof TOOL_OPEN_REASONS)[number];

/** Tool lifecycle with a mandatory `beforeHandle` access / scope gate. */
export interface ToolGate extends ToolLifecycle {
  /** Auth / scope gate — throw to reject the call. */
  beforeHandle: NonNullable<ToolLifecycle['beforeHandle']>;
}

/**
 * Required access declaration for mounting contract or runtime tools.
 * Pass `{ gate }` with `beforeHandle`, or explicitly mark the surface `{ open }`.
 */
export type ToolAccess =
  | { readonly gate: ToolGate; readonly open?: never; readonly afterHandle?: never }
  | {
      readonly open: ToolOpenReason;
      readonly afterHandle?: ToolLifecycle['afterHandle'];
      readonly gate?: never;
    };

const TOOL_OPEN_REASON_SET: ReadonlySet<string> = new Set(TOOL_OPEN_REASONS);

function accessRequiredMessage(entryName: string): string {
  return `${entryName}: access is required — pass { gate } with the auth hook or { open }`;
}

function legacyLifecycleMessage(entryName: string): string {
  return `${entryName}: access is required — pass { gate } with the auth hook or { open } ("lifecycle" was replaced by "access")`;
}

function isBeforeHandleHook(
  value: unknown,
): value is NonNullable<ToolLifecycle['beforeHandle']> {
  return typeof value === 'function';
}

function isAfterHandleHook(
  value: unknown,
): value is NonNullable<ToolLifecycle['afterHandle']> {
  return typeof value === 'function';
}

function isToolOpenReason(value: unknown): value is ToolOpenReason {
  return typeof value === 'string' && TOOL_OPEN_REASON_SET.has(value);
}

/**
 * Validate `config.access` at mount time — before the first call — and return
 * the normalized `ToolLifecycle` for the shared tool runner.
 */
export function resolveToolAccess(entryName: string, config: unknown): ToolLifecycle {
  if (!isRecord(config)) {
    throw new TypeError(accessRequiredMessage(entryName));
  }
  if (Object.hasOwn(config, 'lifecycle')) {
    throw new TypeError(legacyLifecycleMessage(entryName));
  }
  if (!Object.hasOwn(config, 'access')) {
    throw new TypeError(accessRequiredMessage(entryName));
  }
  const { access } = config;
  if (!isRecord(access)) {
    throw new TypeError(accessRequiredMessage(entryName));
  }

  const hasGate = Object.hasOwn(access, 'gate') && access.gate !== undefined;
  const hasOpen = Object.hasOwn(access, 'open') && access.open !== undefined;
  if (hasGate === hasOpen) {
    throw new TypeError(accessRequiredMessage(entryName));
  }

  if (hasGate) {
    for (const key of Object.keys(access)) {
      if (key === 'gate') continue;
      if ((key === 'open' || key === 'afterHandle') && access[key] === undefined) continue;
      throw new TypeError(accessRequiredMessage(entryName));
    }
    const { gate } = access;
    if (!isRecord(gate)) {
      throw new TypeError(accessRequiredMessage(entryName));
    }
    const { beforeHandle, afterHandle } = gate;
    if (!isBeforeHandleHook(beforeHandle)) {
      throw new TypeError(accessRequiredMessage(entryName));
    }
    if (afterHandle !== undefined && !isAfterHandleHook(afterHandle)) {
      throw new TypeError(accessRequiredMessage(entryName));
    }
    return afterHandle !== undefined ? { beforeHandle, afterHandle } : { beforeHandle };
  }

  for (const key of Object.keys(access)) {
    if (key === 'open' || key === 'afterHandle') continue;
    if (key === 'gate' && access[key] === undefined) continue;
    throw new TypeError(accessRequiredMessage(entryName));
  }
  const { open, afterHandle } = access;
  if (!isToolOpenReason(open)) {
    throw new TypeError(accessRequiredMessage(entryName));
  }
  if (afterHandle !== undefined && !isAfterHandleHook(afterHandle)) {
    throw new TypeError(accessRequiredMessage(entryName));
  }
  return afterHandle !== undefined ? { afterHandle } : {};
}

/**
 * CLI access check: required whenever `services` or `runtimeTools` are configured;
 * optional on native-only CLIs (`commands` only). Legacy `lifecycle` is always refused.
 */
export function resolveOptionalCliToolAccess(
  entryName: string,
  config: unknown,
): ToolLifecycle {
  if (!isRecord(config)) {
    throw new TypeError(accessRequiredMessage(entryName));
  }
  if (Object.hasOwn(config, 'lifecycle')) {
    throw new TypeError(legacyLifecycleMessage(entryName));
  }
  const hasManagedSurface = config.services !== undefined || config.runtimeTools !== undefined;
  if (hasManagedSurface || (Object.hasOwn(config, 'access') && config.access !== undefined)) {
    return resolveToolAccess(entryName, config);
  }
  return {};
}
