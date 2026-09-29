/**
 * What a screen button carries in `callback_data`, and how it is read back.
 *
 * Telegram gives a button 1–64 **bytes** of UTF-8 and sends them back when it
 * is pressed. Anything can arrive there: a button from a release that no longer
 * exists, and — through MTProto's `getBotCallbackAnswer` — bytes no button ever
 * carried. So the address is compact, keyed by the screen's stable id rather
 * than by anything positional that shifts between releases, and every decoded
 * value is still user input for the screen to validate.
 *
 * Grammar, after the application's prefix:
 *
 *     [!]<screen>[.<action>](:<param>)*(:<key>=<value>)*    a button; `!` opens it below
 *     #<token>                                             a button whose address did not fit
 *
 * Path params travel positionally — a screen's params are fixed by its path —
 * and an action's input by name, so adding a field to an input schema never
 * reassigns the values an older button carries. Values keep their type: a
 * string is percent-escaped where it would break the grammar (`%`, `:`, a
 * leading `~`), anything else is tagged — `~t`, `~f`, `~n`, `~12` — and a
 * lowercase UUID, the commonest id in a path, travels as `~u` plus 22
 * base64url characters instead of 36.
 */
import { base64UrlToBytes, bytesToBase64Url } from '../../internal/base64url';
import { compareCodeUnits } from '../../internal/canonical-json';
import { isUnsafeKey } from '../../internal/safe-json';

/** Telegram's limit for `callback_data`, in UTF-8 bytes. */
export const CALLBACK_DATA_LIMIT = 64;

/** A value a param or an action's input may carry through a button. */
export type ActionValue = string | number | boolean | null;

const NAME = /^[A-Za-z0-9_-]+$/;
const INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPACT_UUID = /^~u[A-Za-z0-9_-]{22}$/;

export interface CallbackAddress {
  readonly screen: string;
  readonly action?: string;
  readonly params: readonly ActionValue[];
  readonly input?: Readonly<Record<string, ActionValue | undefined>>;
  /** Opens the screen below instead of changing the message it is on. */
  readonly detached?: boolean;
}

export type ParsedCallback =
  | { readonly kind: 'token'; readonly token: string }
  | {
      readonly kind: 'address';
      readonly screen: string;
      readonly action: string | undefined;
      readonly detached: boolean;
      /** Still encoded: the screen decides which are params and which input. */
      readonly segments: readonly string[];
    };

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A screen id, action name or token: safe inside the grammar without escaping. */
export function assertCallbackName(kind: string, name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `[stitchkit] telegram screens: ${kind} "${name}" may contain only letters, digits, "_" and "-".`,
    );
  }
}

function escapeText(value: string): string {
  const escaped = value.replaceAll('%', '%25').replaceAll(':', '%3A');
  return escaped.startsWith('~') ? `%7E${escaped.slice(1)}` : escaped;
}

function unescapeText(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function compactUuid(uuid: string): string {
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return `~u${bytesToBase64Url(bytes)}`;
}

function expandUuid(segment: string): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(segment.slice(2));
  } catch {
    return undefined;
  }
  if (bytes.length !== 16) return undefined;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeValue(value: ActionValue): string {
  if (typeof value === 'string')
    return UUID.test(value) ? compactUuid(value) : escapeText(value);
  if (value === null) return '~n';
  if (typeof value === 'boolean') return value ? '~t' : '~f';
  if (!Number.isFinite(value)) {
    throw new Error('[stitchkit] telegram screens: a number in a button must be finite.');
  }
  return `~${value}`;
}

/** A decoded value, or `undefined` when the segment is not one this codec writes. */
function decodeValue(segment: string): ActionValue | undefined {
  if (!segment.startsWith('~')) return unescapeText(segment);
  if (segment === '~n') return null;
  if (segment === '~t') return true;
  if (segment === '~f') return false;
  if (COMPACT_UUID.test(segment)) return expandUuid(segment);
  const number = Number(segment.slice(1));
  return segment.length > 1 && Number.isFinite(number) ? number : undefined;
}

export function encodeCallback(address: CallbackAddress): string {
  assertCallbackName('screen id', address.screen);
  if (address.action !== undefined) assertCallbackName('action', address.action);
  let body = address.detached ? `!${address.screen}` : address.screen;
  if (address.action !== undefined) body += `.${address.action}`;
  for (const param of address.params) body += `:${encodeValue(param)}`;
  const entries = Object.entries(address.input ?? {})
    .filter((entry): entry is [string, ActionValue] => entry[1] !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [key, value] of entries) {
    if (!INPUT_KEY.test(key) || isUnsafeKey(key)) {
      throw new Error(
        `[stitchkit] telegram screens: button input key "${key}" is not allowed.`,
      );
    }
    body += `:${key}=${encodeValue(value)}`;
  }
  return body;
}

export function encodeToken(token: string): string {
  return `#${token}`;
}

export function parseCallback(body: string): ParsedCallback | null {
  if (body.startsWith('#')) {
    const token = body.slice(1);
    return NAME.test(token) ? { kind: 'token', token } : null;
  }
  const detached = body.startsWith('!');
  const [head = '', ...segments] = (detached ? body.slice(1) : body).split(':');
  const dot = head.indexOf('.');
  const screen = dot === -1 ? head : head.slice(0, dot);
  const action = dot === -1 ? undefined : head.slice(dot + 1);
  if (!NAME.test(screen) || (action !== undefined && !NAME.test(action))) return null;
  return { kind: 'address', screen, action, detached, segments };
}

/** Positional path params; `null` when any is malformed. */
export function decodeParams(segments: readonly string[]): ActionValue[] | null {
  const params: ActionValue[] = [];
  for (const segment of segments) {
    const value = decodeValue(segment);
    if (value === undefined) return null;
    params.push(value);
  }
  return params;
}

/** Named input entries; `null` when any is malformed, unsafe or repeated. */
export function decodeInput(segments: readonly string[]): Record<string, ActionValue> | null {
  const input: Record<string, ActionValue> = {};
  for (const segment of segments) {
    const equals = segment.indexOf('=');
    if (equals === -1) return null;
    const key = segment.slice(0, equals);
    if (!INPUT_KEY.test(key) || isUnsafeKey(key) || Object.hasOwn(input, key)) return null;
    const value = decodeValue(segment.slice(equals + 1));
    if (value === undefined) return null;
    input[key] = value;
  }
  return input;
}
