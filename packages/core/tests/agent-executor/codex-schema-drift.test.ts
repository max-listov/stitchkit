/**
 * Every field the Codex driver reads or writes exists in the JSON Schema the
 * pinned CLI generates. The driver's Zod slices let unknown fields through,
 * so a field Codex renames would fail silently in a turn; it fails here.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CODEX_APPROVAL_DECISION,
  CODEX_APPROVAL_REQUESTS,
  CODEX_INPUT_REQUEST,
} from '../../src/agent-executor/codex/protocol';

const Definition = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  enum: z.array(z.string()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
});
const fixture = z
  .looseObject({ codexVersion: z.string(), definitions: z.record(z.string(), Definition) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../fixtures/codex-app-server-0.162.1.schema.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const top = (name: string) => Definition.parse(Reflect.get(fixture, name));
const definition = (name: string) => {
  const found = fixture.definitions[name];
  if (found === undefined) throw new Error(`${name} is not in the pinned schema`);
  return found;
};
const properties = (value: z.infer<typeof Definition>) => Object.keys(value.properties ?? {});
const variants = (value: z.infer<typeof Definition>) =>
  [...(value.oneOf ?? []), ...(value.anyOf ?? [])].map((entry) => Definition.parse(entry));

const FIELDS: Record<string, string[]> = {
  AgentMessageDeltaNotification: ['itemId', 'delta'],
  ReasoningTextDeltaNotification: ['itemId', 'delta'],
  ItemStartedNotification: ['item'],
  ItemCompletedNotification: ['item'],
  TurnCompletedNotification: ['turn'],
  Turn: ['id', 'status', 'error', 'items'],
  TurnError: ['message', 'codexErrorInfo'],
  ThreadTokenUsageUpdatedNotification: ['tokenUsage'],
  ThreadTokenUsage: ['last'],
  TokenUsageBreakdown: ['inputTokens', 'outputTokens', 'cachedInputTokens'],
  ServerRequestResolvedNotification: ['requestId'],
  TurnStartParams: ['threadId', 'input', 'clientUserMessageId'],
  TurnStartResponse: ['turn'],
  TurnInterruptParams: ['threadId', 'turnId'],
  ThreadStartParams: ['cwd', 'approvalPolicy', 'sandbox', 'model'],
  ThreadStartResponse: ['thread'],
  ThreadResumeParams: ['threadId', 'excludeTurns'],
  ThreadTurnsListParams: ['threadId', 'limit'],
  ThreadTurnsListResponse: ['data'],
  GetAccountRateLimitsResponse: ['rateLimits'],
};

test(`the driver's fields exist in the schema of codex-cli ${fixture.codexVersion}`, () => {
  const missing = Object.entries(FIELDS).flatMap(([name, fields]) =>
    fields
      .filter((field) => !properties(definition(name)).includes(field))
      .map((field) => `${name}.${field}`),
  );
  for (const [name, fields] of [
    ['InitializeCapabilities', ['experimentalApi', 'optOutNotificationMethods']],
    ['ToolRequestUserInputResponse', ['answers']],
    ['CommandExecutionRequestApprovalParams', ['itemId', 'command']],
  ] as const) {
    for (const field of fields)
      if (!properties(top(name)).includes(field)) missing.push(`${name}.${field}`);
  }
  expect(missing).toEqual([]);
});

test('the turn statuses, error kinds, decisions and item types the driver names are the schema’s', () => {
  expect(definition('TurnStatus').enum).toEqual(
    expect.arrayContaining(['completed', 'interrupted', 'failed', 'inProgress']),
  );
  const errorKinds = variants(definition('CodexErrorInfo')).flatMap(
    (entry) => entry.enum ?? [],
  );
  expect(errorKinds).toEqual(
    expect.arrayContaining(['unauthorized', 'usageLimitExceeded', 'rateLimitExceeded']),
  );
  // Every decision the driver answers with is one both approvals take.
  for (const name of ['CommandExecutionApprovalDecision', 'FileChangeApprovalDecision']) {
    const decisions = variants(top(name)).flatMap((entry) => entry.enum ?? []);
    expect(decisions, name).toEqual(
      expect.arrayContaining(Object.values(CODEX_APPROVAL_DECISION)),
    );
  }
  const items = variants(definition('ThreadItem'));
  const typeOf = (entry: z.infer<typeof Definition>) =>
    Definition.parse(Reflect.get(entry.properties ?? {}, 'type') ?? {}).enum?.[0];
  expect(items.map(typeOf)).toEqual(
    expect.arrayContaining([
      'userMessage',
      'agentMessage',
      'reasoning',
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'webSearch',
    ]),
  );
  const userMessage = items.find((entry) => typeOf(entry) === 'userMessage');
  expect(properties(userMessage ?? {})).toContain('clientId');
  expect([...CODEX_APPROVAL_REQUESTS, CODEX_INPUT_REQUEST]).toEqual([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
  ]);
});
