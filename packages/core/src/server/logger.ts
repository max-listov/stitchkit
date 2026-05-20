/**
 * Request logger. Development: pretty colored `→` / `←` lines. Production:
 * one structured JSON line per completed request. Zero dependencies — a
 * project that wants its own sink passes a `StitchLogger` to
 * `createHandler({ logging })` instead.
 */
import { extractIp } from './request';

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

const isProd = process.env.NODE_ENV === 'production';

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

export function elapsedMs(startTime: bigint): number {
  return Number(process.hrtime.bigint() - startTime) / 1e6;
}

/** Map an HTTP status to a log level. */
export function levelForStatus(status: number): 'error' | 'warn' | 'info' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/** The structured fields shared by every completed-request log line. */
export function buildLogFields(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  traceId: string,
): { traceId: string; method: string; path: string; status: number; durationMs: number } {
  return { traceId, method, path, status, durationMs };
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
  startTime: bigint;
}

const SKIP_PREFIXES = ['/_bun/', '/_bundle', '/favicon'];

export function shouldLog(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return false;
  return !SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Open the timing window for a request. Development prints a `→` line. */
export function logIncoming(req: Request, pathname: string, traceId: string): RequestLog {
  const log: RequestLog = { traceId, startTime: process.hrtime.bigint() };
  if (!isProd) {
    const mc = METHOD_COLOR[req.method] ?? c.dim;
    console.log(
      `${c.gray}[${timestamp()}]${c.reset} ${mc}${req.method}${c.reset} ${c.dim}${traceId}${c.reset} ${c.cyan}→${c.reset} ${pathname} ${ipLabel(extractIp(req))}`,
    );
  }
  return log;
}

/** Close a request. Development: `←` line. Production: one structured JSON line. */
export function logOutgoing(
  req: Request,
  pathname: string,
  status: number,
  log: RequestLog,
): void {
  const ms = elapsedMs(log.startTime);

  if (isProd) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: levelForStatus(status),
        msg: `${req.method} ${pathname} ${status}`,
        ...buildLogFields(req.method, pathname, status, Math.round(ms), log.traceId),
        ip: extractIp(req) || undefined,
      }),
    );
    return;
  }

  const mc = METHOD_COLOR[req.method] ?? c.dim;
  console.log(
    `${c.gray}[${timestamp()}]${c.reset} ${mc}${req.method}${c.reset} ${c.dim}${log.traceId}${c.reset} ${c.cyan}←${c.reset} ${pathname} ${statusColor(status)}${status}${c.reset} ${durationColor(ms)}${formatMs(ms)}${c.reset} ${ipLabel(extractIp(req))}`,
  );
}
