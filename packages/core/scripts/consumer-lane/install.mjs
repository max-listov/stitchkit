import { execFileSync } from 'node:child_process';

/** Bounded retry backoff schedule (ms) for transient npm registry install failures. */
export const DEFAULT_NPM_INSTALL_BACKOFF_MS = Object.freeze([2_000, 5_000, 10_000]);

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const FATAL_INSTALL_PATTERNS = [
  /integrity check failed|\bEINTEGRITY\b/i,
  /invalid package\.json|JSON Parse error|WorkspaceNotFound/i,
  /no version matching|\bVersionNotFound\b/i,
  /(?:HTTP\s*|-\s*)(?:401|403)\b|\bEACCES\b/i,
  /\bENOENT\b[^\n]*file:/i,
];

const TRANSIENT_TARBALL_PATTERNS = [
  /https?:\/\/registry\.npmjs\.org\/[^\s"'`]+\.tgz\b[^\n]*(?:\b(?:404|429|500|502|503|504)\b|TarballNotFound|Failed to download)/i,
  /(?:Failed to download|TarballNotFound)[^\n]*https?:\/\/registry\.npmjs\.org\/[^\s"'`]+\.tgz\b/i,
  /https?:\/\/registry\.npmjs\.org\/[^\s"'`]+[^\n]*(?:-\s*|HTTP\s*)(?:429|500|502|503|504)\b/i,
  /https?:\/\/registry\.npmjs\.org\/[^\s"'`]+[^\n]*(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|FailedToOpenSocket|ConnectionReset|SocketClosed|TLS handshake)/i,
  /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|FailedToOpenSocket|ConnectionReset|SocketClosed)[^\n]*registry\.npmjs\.org/i,
];

/**
 * Classify whether a `bun install` failure output represents a transient npm
 * registry tarball CDN race (e.g. HTTP 404 on a freshly published `.tgz`),
 * transient registry 429/5xx, or registry socket reset. Resolution errors,
 * manifest errors, local `file:` failures, auth failures and metadata 404s
 * return `false` so they fail immediately without masking broken installs.
 */
export function isTransientNpmInstallError(output) {
  if (typeof output !== 'string' || output.trim().length === 0) return false;
  for (const fatal of FATAL_INSTALL_PATTERNS) {
    if (fatal.test(output)) return false;
  }
  return TRANSIENT_TARBALL_PATTERNS.some((pattern) => pattern.test(output));
}

/** Synchronous sleep via `Atomics.wait` for CLI/script retry backoff in Bun and Node. */
export function sleepSync(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  Atomics.wait(SLEEP_BUFFER, 0, 0, Math.ceil(delayMs));
}

function errorOutputText(error) {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const parts = [];
  if (typeof error.stdout === 'string' && error.stdout) parts.push(error.stdout);
  if (typeof error.stderr === 'string' && error.stderr) parts.push(error.stderr);
  if (typeof error.message === 'string' && error.message) parts.push(error.message);
  return parts.join('\n');
}

function firstDiagnosticLine(text) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? 'transient npm install error'
  );
}

/**
 * Run `bun install` with bounded backoff retries on transient npm registry
 * tarball/network failures. Any other error fails immediately on the first attempt.
 */
export function runBunInstall(cwd, args = ['install', '--no-save'], options = {}) {
  const delaysMs = options.delaysMs ?? DEFAULT_NPM_INSTALL_BACKOFF_MS;
  if (!Array.isArray(delaysMs)) {
    throw new TypeError(
      'runBunInstall: delaysMs must be an array of non-negative finite numbers',
    );
  }
  for (const delay of delaysMs) {
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      throw new TypeError(`runBunInstall: invalid backoff delay ${String(delay)}`);
    }
  }
  const exec =
    options.exec ??
    ((targetCwd, commandArgs) =>
      execFileSync('bun', commandArgs, {
        cwd: targetCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
      }));
  const sleep = options.sleep ?? sleepSync;
  const onRetry =
    options.onRetry ??
    (({ attempt, maxAttempts, delayMs, reason }) => {
      console.warn(
        `[consumer-lane] transient npm install failure (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms: ${reason}`,
      );
    });
  const maxAttempts = delaysMs.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return exec(cwd, args);
    } catch (error) {
      const output = errorOutputText(error);
      const delayMs = delaysMs[attempt - 1];
      if (delayMs === undefined || !isTransientNpmInstallError(output)) {
        throw error;
      }
      onRetry({
        attempt,
        maxAttempts,
        delayMs,
        cwd,
        args,
        reason: firstDiagnosticLine(output),
      });
      sleep(delayMs);
    }
  }
}
