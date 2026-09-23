import { isUnsafeKey } from '../internal/safe-json';
import type { EndpointDef } from './define';
import type { EndpointToolOptions } from './tool-options';

export function assertPositiveLimit(
  where: string,
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${where} ${name} must be a positive safe integer, received ${value}`);
  }
}

/** Multipart is one declarative HTTP-only request boundary. */
export function assertMultipartEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": multipart endpoint "${key}"`;
  if (ep.method !== 'POST' && ep.method !== 'PUT' && ep.method !== 'PATCH') {
    throw new Error(`${where} must use POST, PUT or PATCH`);
  }
  const multipart = ep.multipart;
  if (!multipart || typeof multipart !== 'object') {
    throw new Error(`${where} must declare a multipart descriptor`);
  }
  assertPositiveLimit(where, 'maxRequestBytes', multipart.maxRequestBytes);
  assertPositiveLimit(where, 'maxFieldBytes', multipart.maxFieldBytes);
  const entries = Object.entries(multipart.files);
  if (entries.length === 0) throw new Error(`${where} must declare at least one file field`);
  for (const [field, policy] of entries) {
    if (!field || isUnsafeKey(field))
      throw new Error(`${where} has an invalid file field name`);
    assertPositiveLimit(`${where} field "${field}"`, 'maxBytes', policy.maxBytes);
    assertPositiveLimit(`${where} field "${field}"`, 'maxFiles', policy.maxFiles);
    if (policy.multiple !== true && policy.maxFiles !== undefined) {
      throw new Error(`${where} field "${field}" may set maxFiles only with multiple: true`);
    }
    if (policy.contentTypes) {
      if (policy.contentTypes.length === 0) {
        throw new Error(`${where} field "${field}" contentTypes cannot be empty`);
      }
      for (const contentType of policy.contentTypes) {
        if (!/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(contentType)) {
          throw new Error(
            `${where} field "${field}" has invalid content type policy "${contentType}"`,
          );
        }
      }
    }
  }
}

/**
 * A raw endpoint hands the whole response to the handler, so everything that
 * only makes sense for a *tool* is meaningless on it. The type already forbids
 * each of these; this repeats the rule for a contract assembled at runtime —
 * and it fails loudly at definition time rather than shipping a tool that
 * serializes a `Response` into `{}`. → ADR 0038.
 */
export function assertRawEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": raw endpoint "${key}"`;
  if (ep.output) throw new Error(`${where} cannot declare an output schema`);
  assertNoToolOptions(where, ep);
  const nonHttp = (ep.expose ?? []).filter((t) => t !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

export function assertStreamingResponseEndpoint(
  prefix: string,
  key: string,
  ep: EndpointDef,
): void {
  const where = `Contract "${prefix}": streaming endpoint "${key}"`;
  if (!('stream' in ep) || !ep.stream || typeof ep.stream !== 'object') {
    throw new Error(`${where} must declare a stream descriptor`);
  }
  if (!ep.stream.item || typeof ep.stream.item.parse !== 'function') {
    throw new Error(`${where} must declare an item schema`);
  }
  const runtimeFormat: unknown = Reflect.get(ep.stream, 'format');
  const runtimeFinalLine: unknown = Reflect.get(ep.stream, 'finalLine');
  if (ep.stream.framing === 'item' && runtimeFormat === 'sse') {
    throw new Error(`${where} item framing is supported only for ndjson`);
  }
  if (ep.stream.framing === 'item' && ep.stream.completion !== 'terminal') {
    throw new Error(`${where} item framing requires terminal completion`);
  }
  if (ep.stream.completion === 'terminal' && !ep.stream.terminal) {
    throw new Error(`${where} terminal completion requires a terminal schema`);
  }
  if (runtimeFinalLine === 'require-newline' && runtimeFormat === 'sse') {
    throw new Error(`${where} finalLine applies only to ndjson`);
  }
  assertPositiveLimit(where, 'maxFrameBytes', ep.stream.maxFrameBytes);
  assertPositiveLimit(where, 'lifetimeMs', ep.stream.lifetimeMs);
  assertPositiveLimit(where, 'heartbeatMs', ep.stream.heartbeatMs);
  if (
    ep.stream.idleTimeoutSeconds !== undefined &&
    (!Number.isSafeInteger(ep.stream.idleTimeoutSeconds) || ep.stream.idleTimeoutSeconds < 0)
  ) {
    throw new Error(`${where} idleTimeoutSeconds must be a non-negative safe integer`);
  }
  if (ep.output) throw new Error(`${where} cannot declare an output schema`);
  if (ep.rawResponse) throw new Error(`${where} cannot also be rawResponse`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  assertNoToolOptions(where, ep);
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

/**
 * Tool options moved into `tool` in 0.94.0. The types cannot catch a leftover
 * top-level key — `defineContract` infers its endpoints, and inference admits
 * extra properties — and an ignored `toolName` would rename a tool without a
 * word. So the old keys are refused by name, with where they went.
 */
const UNGROUPED_TOOL_OPTIONS: Readonly<Record<string, string>> = {
  toolName: 'tool.name',
  toolView: 'tool.view (declared with withToolView)',
  ui: 'tool.ui',
  annotations: 'tool.annotations',
  mcp: 'tool.mcp',
};

/**
 * The keys the `tool` group accepts. Declared against the type, so a new option
 * that is not listed here fails to compile rather than being refused at run time.
 */
const TOOL_OPTION_KEYS = {
  name: true,
  view: true,
  ui: true,
  annotations: true,
  mcp: true,
} as const satisfies Record<keyof EndpointToolOptions, true>;

export function assertNoUngroupedToolOptions(
  prefix: string,
  key: string,
  ep: EndpointDef,
): void {
  const where = `Contract "${prefix}": endpoint "${key}"`;
  for (const [name, moved] of Object.entries(UNGROUPED_TOOL_OPTIONS)) {
    if (Object.hasOwn(ep, name)) {
      throw new Error(
        `${where} sets \`${name}\` — tool options live in \`tool\` since 0.94.0: use ${moved}`,
      );
    }
  }
  // Inside the group the same silence would come back one level down: a
  // `tool: { toolName }` left half-migrated is still an ignored name.
  const group = 'tool' in ep ? ep.tool : undefined;
  if (group === undefined) return;
  for (const name of Object.keys(group)) {
    if (!Object.hasOwn(TOOL_OPTION_KEYS, name)) {
      throw new Error(
        `${where} sets \`tool.${name}\`, which is not a tool option — \`tool\` accepts ${Object.keys(TOOL_OPTION_KEYS).join(', ')}`,
      );
    }
  }
}

/** An endpoint that never reaches a tool transport has no tool options to set. */
export function assertNoToolOptions(where: string, ep: EndpointDef): void {
  if ('tool' in ep && ep.tool !== undefined) {
    throw new Error(`${where} cannot set tool options — it never reaches a tool transport`);
  }
}

/** HEAD is an explicit, bodyless, HTTP-only raw-response operation. */
export function assertHeadEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": HEAD endpoint "${key}"`;
  if (!ep.rawResponse) throw new Error(`${where} must declare rawResponse: true`);
  if (ep.input) throw new Error(`${where} cannot declare an input schema`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if (ep.rawBody) throw new Error(`${where} cannot retain a raw body`);
}

/** Raw JSON text exists only on a validated, body-bearing HTTP operation. */
export function assertRawBodyEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": rawBody endpoint "${key}"`;
  if (!ep.input) throw new Error(`${where} must declare an input schema`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if (ep.method !== 'POST' && ep.method !== 'PUT' && ep.method !== 'PATCH') {
    throw new Error(`${where} must use POST, PUT or PATCH`);
  }
  assertNoToolOptions(where, ep);
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

/**
 * A safelisted body exists only where a simple cross-origin request can carry
 * one: a validated `POST`. Every other shape either has no JSON body (`GET`,
 * `HEAD`, multipart) or always preflights (`PUT`, `PATCH`, `DELETE`), so the
 * flag would buy nothing and only widen the surface the Origin check guards.
 */
export function assertSafelistedBodyEndpoint(
  prefix: string,
  key: string,
  ep: EndpointDef,
): void {
  const where = `Contract "${prefix}": safelistedBody endpoint "${key}"`;
  if (ep.method !== 'POST') throw new Error(`${where} must use POST`);
  if (!ep.input) throw new Error(`${where} must declare an input schema`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if ('stream' in ep && ep.stream) throw new Error(`${where} cannot be a streaming response`);
}

/** Typed response metadata is a static, HTTP-only addition to the data path. */
export function assertResponseMetaEndpoint(
  prefix: string,
  key: string,
  ep: EndpointDef,
): void {
  const where = `Contract "${prefix}": responseMeta endpoint "${key}"`;
  if (!ep.responseMeta || typeof ep.responseMeta !== 'object') {
    throw new Error(`${where} must declare responseMeta as an object`);
  }
  const status = ep.responseMeta.status;
  if (
    status !== undefined &&
    (!Number.isSafeInteger(status) || status < 200 || status > 299)
  ) {
    throw new Error(`${where} status must be a successful 2xx integer, received ${status}`);
  }
  if (ep.output && (status === 204 || status === 205)) {
    throw new Error(`${where} cannot combine output with bodyless status ${status}`);
  }
  if (ep.rawResponse) throw new Error(`${where} cannot also be a rawResponse endpoint`);
  assertNoToolOptions(where, ep);
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}
