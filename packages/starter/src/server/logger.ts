// ── Colors ───────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const METHOD_COLOR: Record<string, string> = {
  GET: c.cyan,
  POST: c.green,
  PUT: c.yellow,
  DELETE: c.red,
};

// ── Request logger ───────────────────────────────────

export function logRequest(method: string, path: string, status: number, ms: number) {
  const color = status >= 500 ? c.red : status >= 400 ? c.yellow : c.green;
  const methodColor = METHOD_COLOR[method] ?? c.dim;
  const time = ms < 1 ? '<1ms' : `${Math.round(ms)}ms`;
  console.log(
    `  ${c.dim}<-${c.reset} ${methodColor}${method}${c.reset} ${path} ${color}${status}${c.reset} ${c.dim}${time}${c.reset}`,
  );
}

export function logError(method: string, path: string, error: string, requestId: string) {
  console.error(
    `  ${c.red}!${c.reset} ${method} ${path} ${c.dim}[${requestId}]${c.reset} ${c.red}${error}${c.reset}`,
  );
}

export function logStartup(name: string, url: string) {
  console.log(
    `\n  ${c.magenta}${name}${c.reset} ${c.dim}->${c.reset} ${c.cyan}${url}${c.reset}\n`,
  );
}
