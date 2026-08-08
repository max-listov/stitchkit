const SINGULAR_EXCEPTIONS = new Set([
  'analytics',
  'status',
  'stats',
  'settings',
  'media',
  'progress',
  'news',
]);

/** The character class every major provider accepts for a tool name. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Replace every character a provider will not accept with `_`.
 *
 * Two variants, because the two halves start from different histories and the
 * goal is to touch nothing that already worked:
 *
 * - the **service** half has always collapsed `-` to `_` (`user-profiles` ⇒
 *   `get_user_profile`), so it keeps doing that and simply covers the rest of the
 *   class as well;
 * - the **method** half was never normalised, so a hyphenated key shipped as
 *   `get-user_note` — legal, and pinned in someone's client config. Keeping `-`
 *   here means only genuinely undeliverable characters change.
 *
 * The method half needs normalising at all because it is an object key
 * (`Record<string, EndpointDef>`) and a runtime-built contract bypasses the type,
 * so `user.profile` is reachable.
 *
 * Deliberately no run-collapsing and no trimming: those would rename names that
 * are legal today (`get__internal`, `list_a__b`, `get_foo_`) for pure cosmetics.
 * → ADR 0035.
 */
function normalizeService(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function normalizeMethod(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function singularize(name: string): string {
  if (SINGULAR_EXCEPTIONS.has(name)) return name;
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

/**
 * Singularize the **last** `_` segment. `SINGULAR_EXCEPTIONS` lists bare words, so
 * comparing it against the whole name only ever matched an unprefixed service:
 * `bot-status` derived `get_bot_statu`, and `admin/analytics` derived
 * `admin/analytic`, both wrong. → ADR 0035.
 */
function singularizeTail(name: string): string {
  const cut = name.lastIndexOf('_');
  if (cut === -1) return singularize(name);
  return `${name.slice(0, cut + 1)}${singularize(name.slice(cut + 1))}`;
}

/**
 * True when a value carries at least one character that survives into a name.
 * Normalisation can neither create nor destroy an alphanumeric, so this is a
 * plain test on the raw value.
 */
export function hasUsableChars(value: string): boolean {
  return /[a-zA-Z0-9]/.test(value);
}

/**
 * Throw unless `name` is a tool name every provider will accept.
 *
 * Nothing else *stops* this: the MCP SDK warns (SEP-986, `validateAndWarnToolName`)
 * but registers the tool anyway, and the `ai` SDK has no rule at all. So an illegal
 * name reaches the provider, which rejects **the whole request** — every tool of
 * that mount goes dark, not just the bad one. A tool name is an
 * *identity* defect like a duplicate name (which also throws unconditionally), not
 * a *representability* one like an unconvertible schema (which gets the
 * schema-validation policy). → ADR 0035.
 */
export function assertToolName(name: string, serviceName: string, key: string): void {
  const where = `service "${serviceName}", method "${key}"`;
  if (!TOOL_NAME_RE.test(name)) {
    const why =
      name.length > 64
        ? `is ${name.length} characters (max 64) — set an explicit \`toolName\``
        : 'must match [a-zA-Z0-9_-]';
    throw new Error(`Tool name "${name}" (${where}) ${why}`);
  }
}

export function toToolName(serviceName: string, methodName: string): string {
  const normalized = normalizeService(serviceName);
  const singular = singularizeTail(normalized);
  const method = normalizeMethod(methodName);

  if (method === 'list') return `list_${normalized}`;
  if (method === 'get') return `get_${singular}`;
  if (method === 'create') return `create_${singular}`;
  if (method === 'update') return `update_${singular}`;
  if (method === 'delete') return `delete_${singular}`;

  const snake = method.replace(/([A-Z])/g, '_$1').toLowerCase();
  return `${snake}_${singular}`.replace(/^_/, '');
}

/**
 * The surface a duplicate name is reported against — only the label differs
 * between the three mounts, the guarantee does not.
 */
export type ToolNameSurface =
  | 'MCP tool name'
  | 'agent tool name'
  | 'CLI command'
  | 'in-process tool name';

/**
 * Throw when a tool name is already taken on this mount.
 *
 * Every mount keeps its own bookkeeping (a `Set`, an object, a `Map`), so this
 * takes the *answer* rather than the container — the point is one message and one
 * guarantee, not one data structure. It matters because that guarantee is now
 * load-bearing documentation: ADR 0035 declines to add a collision check of its
 * own precisely because all three mounts already dedupe, so a fourth mount added
 * later must not quietly skip it.
 */
export function assertUniqueToolName(
  name: string,
  taken: boolean,
  surface: ToolNameSurface,
): void {
  if (taken) {
    throw new Error(`Duplicate ${surface} "${name}" across mounted operations`);
  }
}
