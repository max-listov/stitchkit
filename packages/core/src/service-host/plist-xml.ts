/**
 * Shared Apple XML 1.0 Property List (`.plist`) escaping and formatting helpers
 * reused by both LaunchAgent plists and macOS `.app` `Info.plist` rendering.
 */

/** Primitive or nested value accepted by {@link renderPlistValue}. */
export type PlistValue =
  | string
  | number
  | boolean
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue | undefined };

/** Error factory invoked when a plist field fails XML 1.0 safety validation. */
export type PlistErrorFactory = (message: string) => Error;

const defaultErrorFactory: PlistErrorFactory = (message) => new RangeError(message);

function isXml10Char(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function hasIllegalXml10Char(
  text: string,
  options?: { allowWhitespaceControls?: boolean; rejectDel?: boolean },
): boolean {
  const allowWhitespace = options?.allowWhitespaceControls ?? true;
  const rejectDel = options?.rejectDel ?? false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined || !isXml10Char(cp)) return true;
    if (rejectDel && cp === 0x7f) return true;
    if (!allowWhitespace && (cp === 0x09 || cp === 0x0a || cp === 0x0d)) return true;
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

/**
 * Returns `true` when `value` contains characters illegal in XML 1.0 plists
 * (`NUL`, `DEL`, lone surrogates `0xD800..0xDFFF`, `0xFFFE`/`0xFFFF`, or
 * `< 0x20` other than optional `TAB`/`LF`/`CR`).
 */
export function hasInvalidXmlControlChar(
  value: string,
  allowWhitespaceControls = false,
): boolean {
  return hasIllegalXml10Char(value, { allowWhitespaceControls, rejectDel: true });
}

/** Throw when `value` contains control or illegal XML 1.0 characters in plists. */
export function assertPlistXmlSafe(
  field: string,
  value: string,
  allowWhitespaceControls = false,
  createError: PlistErrorFactory = defaultErrorFactory,
): void {
  if (hasInvalidXmlControlChar(value, allowWhitespaceControls)) {
    throw createError(`Plist field '${field}' contains forbidden XML 1.0 characters`);
  }
}

/**
 * Escape XML 1.0 text content for Apple `.plist` documents, including `&#13;`
 * for carriage return so round-tripping preserves `\r` verbatim.
 */
export function escapePlistXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\r', '&#13;');
}

/** Render one validated `<string>…</string>` plist element. */
export function renderPlistStringElement(
  field: string,
  value: string,
  options?: { allowWhitespaceControls?: boolean; createError?: PlistErrorFactory },
): string {
  assertPlistXmlSafe(
    field,
    value,
    options?.allowWhitespaceControls ?? false,
    options?.createError,
  );
  return `<string>${escapePlistXml(value)}</string>`;
}

/** Render one validated `<key>…</key>` plist element. */
export function renderPlistKeyElement(
  field: string,
  key: string,
  createError: PlistErrorFactory = defaultErrorFactory,
): string {
  if (key.length === 0) {
    throw createError(`Plist key for '${field}' must not be empty`);
  }
  assertPlistXmlSafe(field, key, false, createError);
  return `<key>${escapePlistXml(key)}</key>`;
}

/** Render a typed plist value (`string`, `number`, `boolean`, array, or dict) at `indent`. */
export function renderPlistValue(
  field: string,
  value: PlistValue,
  options?: {
    indent?: number;
    allowWhitespaceControls?: boolean;
    createError?: PlistErrorFactory;
  },
): string {
  const indent = options?.indent ?? 4;
  const pad = ' '.repeat(indent);
  const createError = options?.createError ?? defaultErrorFactory;

  if (typeof value === 'string') {
    return `${pad}${renderPlistStringElement(field, value, options)}`;
  }
  if (typeof value === 'boolean') {
    return `${pad}<${value ? 'true' : 'false'}/>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createError(`Plist numeric field '${field}' must be finite`);
    }
    return Number.isSafeInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    const items = value.map((item, index) =>
      renderPlistValue(`${field}[${index}]`, item, {
        ...options,
        indent: indent + 2,
      }),
    );
    return `${pad}<array>\n${items.join('\n')}\n${pad}</array>`;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, PlistValue] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (entries.length === 0) return `${pad}<dict/>`;
  const innerPad = ' '.repeat(indent + 2);
  const lines: string[] = [];
  for (const [key, item] of entries) {
    lines.push(`${innerPad}${renderPlistKeyElement(`${field}.${key}`, key, createError)}`);
    lines.push(
      renderPlistValue(`${field}.${key}`, item, {
        ...options,
        indent: indent + 2,
      }),
    );
  }
  return `${pad}<dict>\n${lines.join('\n')}\n${pad}</dict>`;
}

/** Wrap pre-rendered top-level `<dict>` entries into a complete Apple XML 1.0 `.plist`. */
export function renderPlistDocument(entries: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    entries.join('\n'),
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const XML_TAG_NAME = /^[A-Za-z_][\w:.-]*$/;

function decodeXmlText(raw: string, allowCdataClose = false): string | undefined {
  if (!allowCdataClose && raw.includes(']]>')) return undefined;
  let out = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const amp = raw.indexOf('&', cursor);
    if (amp < 0) {
      out += raw.slice(cursor);
      break;
    }
    out += raw.slice(cursor, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi < 0) return undefined;
    const body = raw.slice(amp + 1, semi);
    if (body.startsWith('#')) {
      let cp: number;
      if (body.startsWith('#x')) {
        const hex = body.slice(2);
        if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
        cp = Number.parseInt(hex, 16);
      } else {
        const dec = body.slice(1);
        if (!/^[0-9]+$/.test(dec)) return undefined;
        cp = Number.parseInt(dec, 10);
      }
      if (!isXml10Char(cp)) return undefined;
      out += String.fromCodePoint(cp);
    } else {
      const resolved = NAMED_XML_ENTITIES[body];
      if (resolved === undefined) return undefined;
      out += resolved;
    }
    cursor = semi + 1;
  }
  return out;
}

function scanDoctypeEnd(content: string, start: number): number {
  if (!/[ \t\r\n]/.test(content[start + 9] ?? '')) return -1;
  let quote: string | null = null;
  for (let i = start + 10; i < content.length; i += 1) {
    const ch = content[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '<') return -1;
    else if (ch === '>') return i;
  }
  return -1;
}

function scanOpenTag(
  content: string,
  start: number,
): { end: number; name: string; selfClosing: boolean } | null {
  let quote: string | null = null;
  let attrStart = -1;
  let end = -1;
  for (let i = start + 1; i < content.length; i += 1) {
    const ch = content[i];
    if (quote !== null) {
      if (ch === '<') return null;
      if (ch === quote) {
        if (decodeXmlText(content.slice(attrStart, i), true) === undefined) return null;
        quote = null;
        attrStart = -1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      attrStart = i + 1;
    } else if (ch === '<') {
      return null;
    } else if (ch === '>') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let inner = content.slice(start + 1, end).trimEnd();
  const selfClosing = inner.endsWith('/');
  if (selfClosing) inner = inner.slice(0, -1).trimEnd();
  const nameEnd = inner.search(/[ \t\r\n]/);
  const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
  if (!XML_TAG_NAME.test(name)) return null;
  return { end, name, selfClosing };
}

/**
 * Extract the top-level `<dict>` string value for `<key>Label</key>` from an
 * Apple XML 1.0 `.plist` document using a finite XML 1.0 + CDATA tokenizer.
 *
 * Returns `undefined` when the plist declares no top-level `Label`, duplicates
 * it, or violates XML 1.0 rules (unclosed tags/CDATA/comments, illegal control
 * chars including `&#0;`, surrogates `0xD800..0xDFFF`, or `0xFFFE`/`0xFFFF`).
 */
export function extractPlistLabel(content: string): string | undefined {
  if (hasIllegalXml10Char(content)) return undefined;

  const stack: string[] = [];
  let sawRootPlist = false;
  let seenLabelKey = false;
  let expectValueForLabel = false;
  let capturing: 'key' | 'string' | null = null;
  let buffer = '';
  let foundLabel: string | undefined;

  let pos = 0;
  while (pos < content.length) {
    if (content[pos] !== '<') {
      const nextLt = content.indexOf('<', pos);
      const rawText = nextLt < 0 ? content.slice(pos) : content.slice(pos, nextLt);
      pos = nextLt < 0 ? content.length : nextLt;
      const decoded = decodeXmlText(rawText);
      if (decoded === undefined) return undefined;
      if (stack.length === 0) {
        if (decoded.trim().length > 0) return undefined;
      } else if (capturing !== null) {
        buffer += decoded;
      }
      continue;
    }

    // Handle CDATA BEFORE comments so `<!--` / `-->` inside CDATA stay literal text.
    if (content.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) return undefined;
      const end = content.indexOf(']]>', pos + 9);
      if (end < 0) return undefined;
      if (capturing !== null) buffer += content.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }

    if (content.startsWith('<!--', pos)) {
      const end = content.indexOf('-->', pos + 4);
      if (end < 0) return undefined;
      const body = content.slice(pos + 4, end);
      if (body.includes('--') || body.endsWith('-')) return undefined;
      pos = end + 3;
      continue;
    }

    if (content.startsWith('<?', pos)) {
      const end = content.indexOf('?>', pos + 2);
      if (end < 0) return undefined;
      pos = end + 2;
      continue;
    }

    if (content.startsWith('<!DOCTYPE', pos)) {
      if (stack.length !== 0 || sawRootPlist) return undefined;
      const end = scanDoctypeEnd(content, pos);
      if (end < 0) return undefined;
      pos = end + 1;
      continue;
    }

    if (content.startsWith('<!', pos)) return undefined;

    if (content.startsWith('</', pos)) {
      const end = content.indexOf('>', pos + 2);
      if (end < 0) return undefined;
      const closeName = content.slice(pos + 2, end).trimEnd();
      if (!XML_TAG_NAME.test(closeName) || stack.pop() !== closeName) return undefined;
      if (capturing === 'key') {
        capturing = null;
        if (buffer === 'Label') {
          if (seenLabelKey) return undefined;
          seenLabelKey = true;
          expectValueForLabel = true;
        }
        buffer = '';
      } else if (capturing === 'string') {
        capturing = null;
        foundLabel = buffer;
        buffer = '';
      }
      pos = end + 1;
      continue;
    }

    const tag = scanOpenTag(content, pos);
    if (tag === null || capturing !== null) return undefined;

    if (stack.length === 0) {
      if (sawRootPlist || tag.name !== 'plist') return undefined;
      sawRootPlist = true;
      if (!tag.selfClosing) stack.push(tag.name);
    } else if (stack.length === 2 && stack[0] === 'plist' && stack[1] === 'dict') {
      if (tag.name === 'key') {
        if (expectValueForLabel) return undefined;
        if (!tag.selfClosing) {
          stack.push('key');
          capturing = 'key';
          buffer = '';
        }
      } else if (expectValueForLabel) {
        expectValueForLabel = false;
        if (tag.name === 'string') {
          if (tag.selfClosing) foundLabel = '';
          else {
            stack.push('string');
            capturing = 'string';
            buffer = '';
          }
        } else if (!tag.selfClosing) {
          stack.push(tag.name);
        }
      } else if (!tag.selfClosing) {
        stack.push(tag.name);
      }
    } else if (!tag.selfClosing) {
      stack.push(tag.name);
    }
    pos = tag.end + 1;
  }

  if (stack.length !== 0 || !sawRootPlist || expectValueForLabel) return undefined;
  return foundLabel;
}
