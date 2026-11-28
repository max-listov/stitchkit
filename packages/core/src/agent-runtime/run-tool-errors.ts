import { isRecord } from '../internal/typed';

function formatSafeValidationIssues(cause: unknown): string | undefined {
  if (!isRecord(cause) || !Array.isArray(cause.issues) || cause.issues.length === 0) {
    return undefined;
  }
  const summaries: string[] = [];
  for (const issue of cause.issues.slice(0, 5)) {
    if (!isRecord(issue) || typeof issue.message !== 'string') continue;
    const path = Array.isArray(issue.path)
      ? issue.path
          .filter(
            (segment): segment is string | number =>
              typeof segment === 'string' || typeof segment === 'number',
          )
          .join('.')
      : '';
    summaries.push(path.length > 0 ? `${path}: ${issue.message}` : issue.message);
  }
  if (summaries.length === 0) return undefined;
  const suffix = cause.issues.length > 5 ? ` (+${cause.issues.length - 5} more)` : '';
  return `${summaries.join('; ')}${suffix}`;
}

/**
 * Raised when a model calls a tool that does not exist or is not active on the current step.
 *
 * Carries only the tool name and optional active allowlist — never raw argument values.
 */
export class AgentUnknownToolError extends Error {
  readonly reason = 'unknown-tool' as const;
  readonly toolName: string;
  readonly activeTools?: readonly string[];

  constructor(
    toolName: string,
    options?: { readonly activeTools?: readonly string[]; readonly cause?: unknown },
  ) {
    super(
      `Unknown or inactive tool "${toolName}"`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'AgentUnknownToolError';
    this.toolName = toolName;
    if (options?.activeTools !== undefined) {
      this.activeTools = [...options.activeTools];
    }
  }
}

/**
 * Raised when a model supplies malformed JSON or schema-invalid arguments to a tool call.
 *
 * Message is PII-safe: it names only the tool, failure class, and schema issue paths without
 * echoing raw input payloads. The underlying parse/validation error stays on `cause`.
 */
export class AgentInvalidToolInputError extends Error {
  readonly toolName: string;
  readonly reason: 'invalid-json' | 'validation-failed';

  constructor(
    toolName: string,
    options: {
      readonly reason: 'invalid-json' | 'validation-failed';
      readonly cause?: unknown;
    },
  ) {
    const detail =
      options.reason === 'validation-failed'
        ? formatSafeValidationIssues(options.cause)
        : undefined;
    const message =
      options.reason === 'invalid-json'
        ? `Invalid JSON arguments for tool "${toolName}"`
        : detail !== undefined
          ? `Invalid input for tool "${toolName}": ${detail}`
          : `Invalid input for tool "${toolName}"`;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentInvalidToolInputError';
    this.toolName = toolName;
    this.reason = options.reason;
  }
}
