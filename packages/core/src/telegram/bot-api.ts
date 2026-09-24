/**
 * One Bot API call over `fetch`, with no bot library.
 *
 * The operator channel and the broadcast send outside any update handler — from
 * a script, a schedule, a failure observer — where a whole grammY instance is
 * more than the job needs. What they need is one request whose refusal keeps
 * Telegram's own structured answer, because `classifyTelegramSendFailure`
 * reads `error_code` and `parameters.retry_after` before it ever reads prose.
 */

import { isRecord } from '../internal/typed';

/**
 * The shape of a bot token: the bot's numeric id, a colon, the secret.
 *
 * For masking, not for validation — hand it to a logger's
 * `sensitiveUrlPatterns` and a token inside a URL or an error message is not
 * written to the journal.
 */
export const TELEGRAM_BOT_TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{30,}/;

const DEFAULT_API_ROOT = 'https://api.telegram.org';

/** Telegram refused the call. Carries its answer as fields, never the token. */
export class TelegramBotApiError extends Error {
  readonly method: string;
  readonly error_code: number;
  readonly description: string;
  readonly parameters: { readonly retry_after?: number; readonly migrate_to_chat_id?: number };

  constructor(
    method: string,
    answer: {
      error_code: number;
      description: string;
      parameters?: TelegramBotApiError['parameters'];
    },
  ) {
    super(`Telegram ${method} failed: ${answer.error_code} ${answer.description}`);
    this.name = 'TelegramBotApiError';
    this.method = method;
    this.error_code = answer.error_code;
    this.description = answer.description;
    this.parameters = answer.parameters ?? {};
  }
}

export interface TelegramBotApiCall {
  readonly token: string;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** A local Bot API server, e.g. `http://127.0.0.1:8081`. Default: Telegram's. */
  readonly apiRoot?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

/**
 * Call one Bot API method and return its `result`.
 *
 * A refusal throws `TelegramBotApiError`; a transport failure throws an error
 * whose message names the method and never the URL, since the URL holds the
 * token.
 */
export async function callTelegramBotApi(call: TelegramBotApiCall): Promise<unknown> {
  const root = (call.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await (call.fetch ?? fetch)(`${root}/bot${call.token}/${call.method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.params ?? {}),
      ...(call.signal && { signal: call.signal }),
    });
  } catch (error) {
    if (call.signal?.aborted) throw call.signal.reason;
    const kind = error instanceof Error ? error.name : 'Error';
    throw new Error(`Telegram ${call.method} request failed (${kind})`);
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    throw new TelegramBotApiError(call.method, {
      error_code: response.status,
      description: 'response was not JSON',
    });
  }
  if (isRecord(answer) && answer.ok === true) return answer.result;
  const parameters = isRecord(answer) ? answer.parameters : undefined;
  const retryAfter = numberField(parameters, 'retry_after');
  const migrateTo = numberField(parameters, 'migrate_to_chat_id');
  throw new TelegramBotApiError(call.method, {
    error_code: numberField(answer, 'error_code') ?? response.status,
    description:
      isRecord(answer) && typeof answer.description === 'string'
        ? answer.description
        : 'no description',
    parameters: {
      ...(retryAfter !== undefined && { retry_after: retryAfter }),
      ...(migrateTo !== undefined && { migrate_to_chat_id: migrateTo }),
    },
  });
}
