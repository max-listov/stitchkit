/**
 * Request logger — two formats, chosen by `logging.format`: `pretty` (coloured
 * `→` / `←` lines for a terminal) or `json` (one structured record per
 * completed request). Unset, the choice follows `NODE_ENV` at request time.
 * Zero dependencies — a project that wants its own sink passes a `StitchLogger`
 * as `logging.logger` instead, and then the format does not apply.
 */
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const METHOD_COLOR: Record<string, string> = {
  GET: c.green,
  POST: c.yellow,
  PUT: c.blue,
  PATCH: c.cyan,
  DELETE: c.red,
  OPTIONS: c.gray,
};

/**
 * The environment table, reached through a variable **on purpose**. A bundler
 * folds a literal `process.env.NODE_ENV` into its value at build time — and for
 * a library that is *our* build, not the consumer's, so the decision would be
 * frozen for everyone who installs the package. Read the bag instead, and read
 * it per call: a library cannot know the environment it will be run in.
 */
const runtimeEnv: Record<string, string | undefined> = process.env;

/** How a completed request is written. */
export type LogFormat = 'pretty' | 'json';

/**
 * The format to use: the caller's choice, else derived from `NODE_ENV` at the
 * moment of the call.
 */
export function resolveLogFormat(preference?: LogFormat): LogFormat {
  if (preference) return preference;
  return runtimeEnv.NODE_ENV === 'production' ? 'json' : 'pretty';
}

function timestamp(): string {
  const now = new Date();
  const t = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${t}.${now.getMilliseconds().toString().padStart(3, '0')}`;
}

/** Elapsed milliseconds since a `performance.now()` mark. */
export function elapsedMs(startTime: number): number {
  return performance.now() - startTime;
}

/**
 * Strip control characters from a path — it must never inject CRLF / ANSI into a
 * log line. Done with a char-code filter, not a regex: a control-char regex must
 * be written either with raw control bytes in the source (which the bundler
 * copies into `dist/`, and some Bun regex-parser versions reject a raw-byte
 * character class at module load — crashing every `import`) or with fragile
 * `\u` escapes. Plain code carries no control bytes and parses everywhere.
 */
function safePath(pathname: string): string {
  let out = '';
  for (let i = 0; i < pathname.length; i++) {
    const code = pathname.charCodeAt(i);
    // Drop C0 controls (0x00–0x1f) and DEL (0x7f).
    if (code > 0x1f && code !== 0x7f) out += pathname.charAt(i);
  }
  return out;
}

/** Map an HTTP status to a log level. */
export function levelForStatus(status: number): 'error' | 'warn' | 'info' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * The structured fields shared by every completed-request log line. A missing
 * framework error code is omitted only for an error response, where `enrich`
 * may supply the code a raw `Response` cannot communicate to the framework.
 * Successes retain `errorCode: undefined`, so enrichment cannot forge a failure.
 */
export function buildLogFields(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  traceId: string,
  errorCode?: string,
): {
  traceId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
} {
  const fields = { traceId, method, path, status, durationMs };
  if (errorCode === undefined && status >= 400) return fields;
  return { ...fields, errorCode };
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${Math.round(ms)}ms`;
  return `${Math.round(ms * 1000)}µs`;
}

function durationColor(ms: number): string {
  if (ms >= 1000) return c.red;
  if (ms > 300) return c.yellow;
  return c.green;
}

function statusColor(status: number): string {
  if (status >= 500) return c.red;
  if (status >= 400) return c.yellow;
  if (status >= 300) return c.cyan;
  return c.green;
}

function ipLabel(ip: string): string {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return `${c.magenta}local${c.reset}`;
  return `${c.dim}${ip}${c.reset}`;
}

export interface RequestLog {
  traceId: string;
  startTime: number;
}

const SKIP_PREFIXES = ['/_bun/', '/_bundle', '/favicon'];

export function shouldLog(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return false;
  return !SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Open the timing window for a request. The `pretty` format prints a `→` line
 * so a hanging request is visible before it finishes; `json` does not — a
 * record store wants one row per completed request, not a half of one.
 */
export function logIncoming(
  req: Request,
  pathname: string,
  traceId: string,
  format: LogFormat,
  ipAddress?: string,
): RequestLog {
  const log: RequestLog = { traceId, startTime: performance.now() };
  if (format === 'pretty') {
    const mc = METHOD_COLOR[req.method] ?? c.dim;
    console.log(
      `${c.gray}[${timestamp()}]${c.reset} ${mc}${req.method}${c.reset} ${c.dim}${traceId}${c.reset} ${c.cyan}→${c.reset} ${safePath(pathname)} ${ipLabel(ipAddress ?? '')}`,
    );
  }
  return log;
}

/**
 * Serialise one structured line: consumer fields under the framework's own. A
 * value `JSON.stringify` refuses (a cycle, a `BigInt`) costs the consumer
 * fields for that line — never the record, which is re-emitted alone.
 */
export function structuredLine(
  own: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  try {
    return JSON.stringify({ ...extra, ...own });
  } catch {
    return JSON.stringify(own);
  }
}

/** One finished request, as the formatter needs it. */
export interface CompletedRequest {
  req: Request;
  pathname: string;
  status: number;
  log: RequestLog;
  ipAddress?: string;
  errorCode?: string;
  /** Duration the caller already measured — the one `enrich` was shown. */
  durationMs: number;
  /** Which of the two lines to write. */
  format: LogFormat;
  /**
   * Consumer-supplied fields for the structured line — request-context
   * identity and whatever `enrich` returned. Spread *first* so the framework's
   * own fields overwrite anything that collides with them.
   */
  extra?: Record<string, unknown>;
}

/**
 * Close a request. `json` writes one structured record, carrying `extra`.
 * `pretty` writes a `←` line to read — deliberately without `extra`: a line
 * sized for a terminal is not a record to query.
 */
export function logOutgoing(entry: CompletedRequest): void {
  const { req, pathname, status, log, ipAddress, errorCode, durationMs, format, extra } =
    entry;
  const ms = elapsedMs(log.startTime);

  if (format === 'json') {
    // The framework's own fields are one object so they can be re-emitted
    // alone: an `enrich` value that cannot be serialised (a cycle, a `BigInt`)
    // must cost the extra fields, never the whole line.
    const own = {
      ts: new Date().toISOString(),
      level: levelForStatus(status),
      msg: `${req.method} ${pathname} ${status}`,
      ...buildLogFields(req.method, pathname, status, durationMs, log.traceId, errorCode),
      ip: ipAddress,
    };
    console.log(structuredLine(own, extra));
    return;
  }

  const mc = METHOD_COLOR[req.method] ?? c.dim;
  const code = errorCode ? ` ${c.red}${errorCode}${c.reset}` : '';
  console.log(
    `${c.gray}[${timestamp()}]${c.reset} ${mc}${req.method}${c.reset} ${c.dim}${log.traceId}${c.reset} ${c.cyan}←${c.reset} ${safePath(pathname)} ${statusColor(status)}${status}${c.reset}${code} ${durationColor(ms)}${formatMs(ms)}${c.reset} ${ipLabel(ipAddress ?? '')}`,
  );
}
