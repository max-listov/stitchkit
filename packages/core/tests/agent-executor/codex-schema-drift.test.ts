/**
 * Every field the Codex driver reads or writes exists in the JSON Schema the
 * pinned CLI generates. The driver's Zod slices let unknown fields through,
 * so a field Codex renames would fail silently in a turn; it fails here.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CODEX_CONTENT_ITEMS,
  CODEX_TOOL_ITEMS,
} from '../../src/agent-executor/codex/classify';
import {
  CODEX_OPTED_OUT_NOTIFICATIONS,
  CODEX_PARSED_QUIET_NOTIFICATIONS,
  CODEX_QUIET_NOTIFICATIONS,
  CodexNotificationParams,
} from '../../src/agent-executor/codex/notifications';
import {
  CODEX_APPROVAL_DECISION,
  CODEX_APPROVAL_REQUESTS,
  CODEX_ELICITATION_REQUEST,
  CODEX_INPUT_REQUEST,
  CODEX_PERMISSIONS_APPROVAL_REQUEST,
} from '../../src/agent-executor/codex/protocol';

const Definition = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  enum: z.array(z.string()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  definitions: z.record(z.string(), z.unknown()).optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
});
const fixture = z
  .looseObject({
    codexVersion: z.string(),
    definitions: z.record(z.string(), Definition),
    ClientRequestMethods: z.array(z.string()),
    ServerRequestMethods: z.array(z.string()),
    ServerNotificationMethods: z.array(z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../fixtures/codex-app-server-0.171.0.schema.json', import.meta.url),
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
  AgentMessageDeltaNotification: ['threadId', 'turnId', 'itemId', 'delta'],
  ReasoningTextDeltaNotification: ['threadId', 'turnId', 'itemId', 'delta'],
  ReasoningSummaryTextDeltaNotification: [
    'threadId',
    'turnId',
    'itemId',
    'delta',
    'summaryIndex',
  ],
  PlanDeltaNotification: ['threadId', 'turnId', 'itemId', 'delta'],
  ItemStartedNotification: ['threadId', 'turnId', 'item'],
  ItemCompletedNotification: ['threadId', 'turnId', 'item'],
  TurnStartedNotification: ['threadId', 'turn'],
  TurnCompletedNotification: ['threadId', 'turn'],
  ThreadStatusChangedNotification: ['threadId', 'status'],
  ThreadSettingsUpdatedNotification: ['threadId', 'threadSettings'],
  ModelReroutedNotification: ['threadId', 'turnId', 'fromModel', 'toModel', 'reason'],
  Turn: [
    'id',
    'status',
    'error',
    'items',
    'itemsView',
    'startedAt',
    'completedAt',
    'durationMs',
    'rootTurnId',
  ],
  TurnError: ['message', 'codexErrorInfo'],
  ThreadTokenUsageUpdatedNotification: ['threadId', 'turnId', 'tokenUsage'],
  ThreadTokenUsage: ['last', 'total', 'modelContextWindow'],
  TokenUsageBreakdown: [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'reasoningOutputTokens',
    'totalTokens',
  ],
  ServerRequestResolvedNotification: ['threadId', 'requestId'],
  AccountRateLimitsUpdatedNotification: ['rateLimits'],
  Thread: [
    'id',
    'name',
    'preview',
    'cwd',
    'model',
    'modelProvider',
    'reasoningEffort',
    'status',
    'canAcceptDirectInput',
    'cliVersion',
    'createdAt',
    'updatedAt',
    'recencyAt',
    'ephemeral',
    'path',
    'source',
    'sessionId',
    'projectId',
    'forkedFromId',
    'parentThreadId',
    'attachedToThreadId',
    'originator',
    'agentNickname',
    'agentRole',
    'gitInfo',
    'turns',
  ],
  ThreadItemEntry: ['turnId', 'item', 'outputDeferred', 'startedAtMs', 'completedAtMs'],
  Model: [
    'id',
    'model',
    'displayName',
    'description',
    'hidden',
    'isDefault',
    'defaultReasoningEffort',
    'supportedReasoningEfforts',
    'inputModalities',
    'upgrade',
    'defaultServiceTier',
    'modelSpecialty',
  ],
  SkillsListEntry: ['cwd', 'skills', 'errors'],
  SkillMetadata: [
    'name',
    'description',
    'path',
    'scope',
    'enabled',
    'pluginId',
    'shortDescription',
    'interface',
    'dependencies',
  ],
  SkillErrorInfo: ['path', 'message'],
  CollaborationModeMask: ['name', 'mode', 'model', 'reasoning_effort'],
  McpServerStatus: [
    'name',
    'authStatus',
    'runtimeStatus',
    'tools',
    'resources',
    'resourceTemplates',
    'environmentId',
    'httpOrigin',
    'pluginId',
    'serverInfo',
    'serverCapabilities',
    'toolListMeta',
    'toolsError',
  ],
  ConfigReadResponse: ['config', 'origins', 'layers'],
  ConfigLayerMetadata: ['name', 'version'],
  GetAccountResponse: ['account', 'requiresOpenaiAuth', 'userId', 'workspaceRouting'],
  GetAccountRateLimitsResponse: [
    'rateLimits',
    'rateLimitsByLimitId',
    'accountId',
    'ordinaryUsageAllowed',
    'rateLimitResetCredits',
    'rateLimitUpsell',
  ],
  RateLimitSnapshot: [
    'limitId',
    'limitName',
    'normalModelSlug',
    'planType',
    'primary',
    'secondary',
    'credits',
    'individualLimit',
    'rateLimitReachedType',
    'spendControlReached',
  ],
  RateLimitWindow: ['usedPercent', 'windowDurationMins', 'resetsAt'],
  ThreadUnsubscribeResponse: ['status'],
  ThreadUnarchiveResponse: ['thread'],
  ThreadMetadataUpdateResponse: ['thread'],
  TurnStartParams: [
    'threadId',
    'input',
    'clientUserMessageId',
    'cwd',
    'model',
    'effort',
    'collaborationMode',
    'approvalPolicy',
    'sandboxPolicy',
    'runtimeWorkspaceRoots',
  ],
  TurnStartResponse: ['turn'],
  TurnSteerParams: ['threadId', 'expectedTurnId', 'input', 'clientUserMessageId'],
  TurnSteerResponse: ['turnId'],
  TurnInterruptParams: ['threadId', 'turnId'],
  ThreadStartParams: [
    'cwd',
    'approvalPolicy',
    'sandbox',
    'model',
    'modelProvider',
    'developerInstructions',
    'runtimeWorkspaceRoots',
    'config',
  ],
  ThreadStartResponse: [
    'thread',
    'model',
    'modelProvider',
    'reasoningEffort',
    'approvalPolicy',
    'sandbox',
    'cwd',
    'runtimeWorkspaceRoots',
  ],
  ThreadResumeParams: [
    'threadId',
    'excludeTurns',
    'cwd',
    'approvalPolicy',
    'sandbox',
    'model',
    'modelProvider',
    'developerInstructions',
    'runtimeWorkspaceRoots',
    'config',
  ],
  ThreadResumeResponse: [
    'thread',
    'model',
    'modelProvider',
    'reasoningEffort',
    'approvalPolicy',
    'sandbox',
    'cwd',
    'runtimeWorkspaceRoots',
  ],
  ThreadForkParams: [
    'threadId',
    'cwd',
    'model',
    'modelProvider',
    'approvalPolicy',
    'sandbox',
    'developerInstructions',
    'runtimeWorkspaceRoots',
    'config',
    'beforeTurnId',
    'lastTurnId',
    'excludeTurns',
    'deferGoalContinuation',
  ],
  ThreadForkResponse: [
    'thread',
    'model',
    'modelProvider',
    'reasoningEffort',
    'approvalPolicy',
    'sandbox',
    'cwd',
    'runtimeWorkspaceRoots',
  ],
  ThreadCompactStartParams: ['threadId'],
  ConfigReadParams: ['cwd', 'includeLayers'],
  ListMcpServerStatusParams: ['cursor', 'limit', 'threadId', 'serverName', 'detail'],
  SkillsListParams: ['cwds', 'forceReload'],
  ModelListParams: ['cursor', 'limit', 'includeHidden', 'modelProvider'],
  GetAccountParams: ['refreshToken'],
  ThreadTurnsListParams: ['threadId', 'limit', 'cursor', 'itemsView', 'sortDirection'],
  ThreadTurnsListResponse: ['data', 'nextCursor'],
  ToolRequestUserInputQuestion: ['id', 'header', 'question', 'options', 'isOther', 'isSecret'],
  ToolRequestUserInputOption: ['label', 'description'],
  ThreadItemOutputDeferral: ['commandExecution', 'mcpToolCall'],
  CollaborationMode: ['mode', 'settings'],
  Settings: ['model', 'reasoning_effort', 'developer_instructions'],
  ThreadRevertParams: ['threadId', 'beforeTurnId'],
  ThreadRevertResponse: ['thread', 'turnsBackwardsCursor', 'itemsBackwardsCursor'],
  ThreadInjectItemsParams: ['threadId', 'items'],
  ThreadUnsubscribeParams: ['threadId'],
  ThreadListParams: [
    'cursor',
    'limit',
    'sortKey',
    'sortDirection',
    'modelProviders',
    'sourceKinds',
    'archived',
    'cwd',
    'searchTerm',
    'sectionId',
    'includedThreadIds',
    'excludedThreadIds',
    'originators',
    'currentAccountOnly',
    'useStateDbOnly',
  ],
  ThreadListResponse: ['data', 'nextCursor', 'backwardsCursor'],
  ThreadLoadedListParams: ['cursor', 'limit'],
  ThreadLoadedListResponse: ['data', 'nextCursor'],
  ThreadArchiveParams: ['threadId'],
  ThreadUnarchiveParams: ['threadId'],
  ThreadMetadataUpdateParams: ['threadId', 'gitInfo'],
  ThreadMetadataGitInfoUpdateParams: ['branch', 'originUrl', 'sha'],
  ThreadSetNameParams: ['threadId', 'name'],
};

type SchemaClassification = 'supported' | 'quiet' | 'opted-out' | 'intentionally-excluded';

/** Verify a schema inventory has zero unclassified entries and zero stale registry entries. */
function auditSchemaRegistry(
  schemaEntries: readonly string[],
  registry: Readonly<Record<string, SchemaClassification>>,
): { readonly unclassified: string[]; readonly stale: string[] } {
  const schemaSet = new Set(schemaEntries);
  const unclassified = schemaEntries.filter((entry) => !(entry in registry));
  const stale = Object.keys(registry).filter((entry) => !schemaSet.has(entry));
  return { unclassified, stale };
}

const CLIENT_REQUEST_REGISTRY: Readonly<Record<string, SchemaClassification>> = {
  initialize: 'supported',
  'thread/start': 'supported',
  'thread/resume': 'supported',
  'thread/fork': 'supported',
  'thread/archive': 'supported',
  'thread/delete': 'intentionally-excluded',
  'thread/unsubscribe': 'supported',
  'thread/name/set': 'supported',
  'thread/goal/set': 'intentionally-excluded',
  'thread/goal/get': 'intentionally-excluded',
  'thread/goal/clear': 'intentionally-excluded',
  'thread/metadata/update': 'supported',
  'thread/attachment/add': 'intentionally-excluded',
  'thread/attachment/list': 'intentionally-excluded',
  'thread/attachmentOwner/list': 'intentionally-excluded',
  'thread/attachment/remove': 'intentionally-excluded',
  'thread/section/move': 'intentionally-excluded',
  'thread/unarchive': 'supported',
  'thread/compact/start': 'supported',
  'thread/shellCommand': 'intentionally-excluded',
  'thread/approveGuardianDeniedAction': 'intentionally-excluded',
  'thread/revert': 'supported',
  'thread/list': 'supported',
  'threadSection/list': 'intentionally-excluded',
  'threadSection/create': 'intentionally-excluded',
  'threadSection/update': 'intentionally-excluded',
  'threadSection/delete': 'intentionally-excluded',
  'thread/loaded/list': 'supported',
  'thread/read': 'supported',
  'thread/turns/list': 'supported',
  'thread/items/list': 'supported',
  'thread/inject_items': 'supported',
  'skills/list': 'supported',
  'skills/extraRoots/set': 'intentionally-excluded',
  'hooks/list': 'intentionally-excluded',
  'marketplace/add': 'intentionally-excluded',
  'marketplace/remove': 'intentionally-excluded',
  'marketplace/upgrade': 'intentionally-excluded',
  'plugin/list': 'intentionally-excluded',
  'plugin/installed': 'intentionally-excluded',
  'plugin/reconcile': 'intentionally-excluded',
  'plugin/read': 'intentionally-excluded',
  'plugin/skill/read': 'intentionally-excluded',
  'plugin/share/save': 'intentionally-excluded',
  'plugin/share/updateTargets': 'intentionally-excluded',
  'plugin/share/list': 'intentionally-excluded',
  'plugin/share/checkout': 'intentionally-excluded',
  'plugin/share/delete': 'intentionally-excluded',
  'app/read': 'intentionally-excluded',
  'app/list': 'intentionally-excluded',
  'app/installed': 'intentionally-excluded',
  'fs/readFile': 'intentionally-excluded',
  'fs/writeFile': 'intentionally-excluded',
  'fs/createDirectory': 'intentionally-excluded',
  'fs/getMetadata': 'intentionally-excluded',
  'fs/readDirectory': 'intentionally-excluded',
  'fs/remove': 'intentionally-excluded',
  'fs/copy': 'intentionally-excluded',
  'fs/watch': 'intentionally-excluded',
  'fs/unwatch': 'intentionally-excluded',
  'skills/config/write': 'intentionally-excluded',
  'plugin/install': 'intentionally-excluded',
  'plugin/uninstall': 'intentionally-excluded',
  'turn/start': 'supported',
  'turn/steer': 'supported',
  'turn/interrupt': 'supported',
  'review/start': 'intentionally-excluded',
  'model/list': 'supported',
  'account/gatewayOAuth/read': 'intentionally-excluded',
  'account/gatewayOAuth/login': 'intentionally-excluded',
  'account/gatewayOAuth/cancel': 'intentionally-excluded',
  'modelProvider/list': 'intentionally-excluded',
  'modelProvider/config/write': 'intentionally-excluded',
  'modelProvider/default/set': 'intentionally-excluded',
  'modelProvider/capabilities/read': 'intentionally-excluded',
  'experimentalFeature/list': 'intentionally-excluded',
  'permissionProfile/list': 'intentionally-excluded',
  'experimentalFeature/enablement/set': 'intentionally-excluded',
  'mcpServer/oauth/login': 'intentionally-excluded',
  'config/mcpServer/reload': 'intentionally-excluded',
  'mcpServerStatus/list': 'supported',
  'mcpServer/resource/read': 'intentionally-excluded',
  'mcpServer/tool/call': 'intentionally-excluded',
  'windowsSandbox/setupStart': 'intentionally-excluded',
  'windowsSandbox/readiness': 'intentionally-excluded',
  'account/login/start': 'intentionally-excluded',
  'account/login/cancel': 'intentionally-excluded',
  'account/logout': 'intentionally-excluded',
  'account/securitySetup/read': 'intentionally-excluded',
  'account/rateLimits/read': 'supported',
  'account/rateLimitResetCredit/consume': 'intentionally-excluded',
  'account/usage/read': 'intentionally-excluded',
  'account/workspaceMessages/read': 'intentionally-excluded',
  'account/sendAddCreditsNudgeEmail': 'intentionally-excluded',
  'feedback/upload': 'intentionally-excluded',
  'feedback/save': 'intentionally-excluded',
  'command/exec': 'intentionally-excluded',
  'command/exec/write': 'intentionally-excluded',
  'command/exec/terminate': 'intentionally-excluded',
  'command/exec/resize': 'intentionally-excluded',
  'config/read': 'supported',
  'externalAgentConfig/detect': 'intentionally-excluded',
  'externalAgentConfig/import': 'intentionally-excluded',
  'externalAgentConfig/import/recordHistory': 'intentionally-excluded',
  'externalAgentConfig/import/readHistories': 'intentionally-excluded',
  'config/value/write': 'intentionally-excluded',
  'config/batchWrite': 'intentionally-excluded',
  'configRequirements/read': 'intentionally-excluded',
  'account/read': 'supported',
  fuzzyFileSearch: 'intentionally-excluded',
};

const SERVER_REQUEST_REGISTRY: Readonly<Record<string, SchemaClassification>> = {
  'item/commandExecution/requestApproval': 'supported',
  'item/fileChange/requestApproval': 'supported',
  'item/tool/requestUserInput': 'supported',
  'mcpServer/elicitation/request': 'supported',
  'item/permissions/requestApproval': 'supported',
  'item/tool/call': 'intentionally-excluded',
  'account/chatgptAuthTokens/refresh': 'intentionally-excluded',
  'attestation/generate': 'intentionally-excluded',
  applyPatchApproval: 'intentionally-excluded',
  execCommandApproval: 'intentionally-excluded',
};

const SERVER_NOTIFICATION_REGISTRY: Readonly<Record<string, SchemaClassification>> = {
  error: 'quiet',
  'thread/started': 'quiet',
  'thread/status/changed': 'quiet',
  'thread/readState/changed': 'quiet',
  'thread/archived': 'quiet',
  'thread/deleted': 'quiet',
  'thread/unarchived': 'quiet',
  'thread/closed': 'quiet',
  'thread/reverted': 'quiet',
  'skills/changed': 'opted-out',
  'thread/name/updated': 'quiet',
  'thread/section/changed': 'quiet',
  'thread/attachment/updated': 'quiet',
  'thread/goal/updated': 'quiet',
  'thread/prediction/updated': 'quiet',
  'thread/goal/cleared': 'quiet',
  'thread/queue/changed': 'quiet',
  'project/changed': 'quiet',
  'thread/project/updated': 'quiet',
  'thread/environment/connected': 'quiet',
  'thread/environment/disconnected': 'quiet',
  'thread/settings/updated': 'quiet',
  'thread/tokenUsage/updated': 'supported',
  'turn/started': 'quiet',
  'hook/started': 'quiet',
  'turn/completed': 'supported',
  'hook/completed': 'quiet',
  'turn/diff/updated': 'opted-out',
  'turn/plan/updated': 'quiet',
  'item/started': 'supported',
  'item/autoApprovalReview/started': 'quiet',
  'item/autoApprovalReview/completed': 'quiet',
  'autoApprovalReview/strictReviewRequired': 'quiet',
  'item/completed': 'supported',
  'item/agentMessage/delta': 'supported',
  'item/plan/delta': 'quiet',
  'command/exec/outputDelta': 'intentionally-excluded',
  'process/outputDelta': 'intentionally-excluded',
  'thread/search/partial': 'intentionally-excluded',
  'process/exited': 'intentionally-excluded',
  'item/commandExecution/outputDelta': 'opted-out',
  'item/commandExecution/terminalInteraction': 'quiet',
  'item/fileChange/outputDelta': 'opted-out',
  'item/fileChange/patchUpdated': 'opted-out',
  'serverRequest/resolved': 'supported',
  'item/mcpToolCall/progress': 'quiet',
  'mcpServer/oauthLogin/completed': 'intentionally-excluded',
  'mcpServer/startupStatus/updated': 'opted-out',
  'mcpServer/event/stream/notification': 'intentionally-excluded',
  'account/updated': 'quiet',
  'account/gatewayOAuth/changed': 'quiet',
  'account/rateLimits/updated': 'supported',
  'app/list/updated': 'opted-out',
  'remoteControl/status/changed': 'opted-out',
  'externalAgentConfig/import/progress': 'intentionally-excluded',
  'externalAgentConfig/import/completed': 'intentionally-excluded',
  'fs/changed': 'intentionally-excluded',
  'item/reasoning/summaryTextDelta': 'supported',
  'item/reasoning/summaryPartAdded': 'quiet',
  'item/reasoning/textDelta': 'supported',
  'thread/compacted': 'quiet',
  'model/rerouted': 'quiet',
  'model/verification': 'quiet',
  'modelProvider/authRecoveryStarted': 'quiet',
  'modelProvider/authRecoveryCompleted': 'quiet',
  'turn/moderationMetadata': 'quiet',
  'model/safetyBuffering/updated': 'quiet',
  warning: 'quiet',
  guardianWarning: 'quiet',
  deprecationNotice: 'quiet',
  configWarning: 'quiet',
  'fuzzyFileSearch/sessionUpdated': 'intentionally-excluded',
  'fuzzyFileSearch/sessionCompleted': 'intentionally-excluded',
  'thread/realtime/started': 'intentionally-excluded',
  'thread/realtime/itemAdded': 'intentionally-excluded',
  'thread/realtime/item/started': 'intentionally-excluded',
  'thread/realtime/item/transcript/delta': 'intentionally-excluded',
  'thread/realtime/item/completed': 'intentionally-excluded',
  'thread/realtime/transcript/delta': 'intentionally-excluded',
  'thread/realtime/transcript/done': 'intentionally-excluded',
  'thread/realtime/outputAudio/delta': 'intentionally-excluded',
  'thread/realtime/sdp': 'intentionally-excluded',
  'thread/realtime/error': 'intentionally-excluded',
  'thread/realtime/closed': 'intentionally-excluded',
  'windows/worldWritableWarning': 'quiet',
  'windowsSandbox/setupCompleted': 'intentionally-excluded',
  'account/login/completed': 'intentionally-excluded',
};

const THREAD_ITEM_REGISTRY: Readonly<Record<string, SchemaClassification>> = {
  userMessage: 'quiet',
  hookPrompt: 'quiet',
  agentMessage: 'quiet',
  functionCallOutput: 'supported',
  plan: 'quiet',
  reasoning: 'quiet',
  commandExecution: 'supported',
  fileChange: 'supported',
  mcpToolCall: 'supported',
  dynamicToolCall: 'supported',
  collabAgentToolCall: 'supported',
  subAgentActivity: 'quiet',
  webSearch: 'supported',
  imageView: 'supported',
  sleep: 'supported',
  imageGeneration: 'supported',
  enteredReviewMode: 'quiet',
  exitedReviewMode: 'quiet',
  contextCompaction: 'quiet',
};

test(`the driver's fields exist in the schema of codex-cli ${fixture.codexVersion}`, () => {
  const missing = Object.entries(FIELDS).flatMap(([name, fields]) =>
    fields
      .filter((field) => !properties(definition(name)).includes(field))
      .map((field) => `${name}.${field}`),
  );
  for (const [name, fields] of [
    ['InitializeResponse', ['userAgent', 'codexHome', 'platformFamily', 'platformOs']],
    ['InitializeCapabilities', ['experimentalApi', 'optOutNotificationMethods']],
    ['ToolRequestUserInputResponse', ['answers']],
    ['ToolRequestUserInputParams', ['itemId', 'questions']],
    [
      'CommandExecutionRequestApprovalParams',
      [
        'itemId',
        'command',
        'cwd',
        'reason',
        'kind',
        'approvalId',
        'commandActions',
        'availableDecisions',
      ],
    ],
    ['FileChangeRequestApprovalParams', ['itemId', 'reason', 'grantRoot']],
    [
      'PermissionsRequestApprovalParams',
      [
        'threadId',
        'turnId',
        'itemId',
        'cwd',
        'permissions',
        'reason',
        'startedAtMs',
        'environmentId',
      ],
    ],
    ['PermissionsRequestApprovalResponse', ['permissions', 'scope', 'strictAutoReview']],
    [
      'McpServerElicitationRequestParams',
      ['serverName', 'threadId', 'turnId', 'environmentId'],
    ],
    ['McpServerElicitationRequestResponse', ['action', 'content', '_meta']],
    ['AppListUpdatedNotification', ['data']],
    ['ThreadReadParams', ['threadId', 'includeTurns']],
    ['ThreadReadResponse', ['thread']],
    ['CollaborationModeListResponse', ['data']],
    [
      'ThreadItemsListParams',
      ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection', 'deferOutput'],
    ],
    ['ThreadItemsListResponse', ['data', 'nextCursor', 'backwardsCursor']],
  ] as const) {
    for (const field of fields)
      if (!properties(top(name)).includes(field)) missing.push(`${name}.${field}`);
  }
  expect(missing).toEqual([]);
  // Negative control: codex-cli 0.171.0 ThreadResumeParams does not declare deferGoalContinuation.
  expect(properties(definition('ThreadResumeParams'))).not.toContain('deferGoalContinuation');
});

test('the turn statuses, error kinds, decisions, collaboration modes and item types the driver names are the schema’s', () => {
  expect(definition('TurnStatus').enum).toEqual(
    expect.arrayContaining(['completed', 'interrupted', 'failed', 'inProgress']),
  );
  expect(definition('ModeKind').enum).toEqual(expect.arrayContaining(['plan', 'default']));
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
  const userInputs = variants(definition('UserInput'));
  const skillInput = userInputs.find((entry) => typeOf(entry) === 'skill');
  expect(properties(skillInput ?? {})).toEqual(
    expect.arrayContaining(['type', 'name', 'path']),
  );
  const localImageInput = userInputs.find((entry) => typeOf(entry) === 'localImage');
  expect(properties(localImageInput ?? {})).toEqual(expect.arrayContaining(['type', 'path']));
  const turnsCursor = Definition.parse(
    Reflect.get(definition('ThreadTurnsListParams').properties ?? {}, 'cursor'),
  );
  expect(turnsCursor.type).toEqual(expect.arrayContaining(['string', 'null']));
  const itemsCursor = Definition.parse(
    Reflect.get(top('ThreadItemsListParams').properties ?? {}, 'cursor'),
  );
  expect(variants(itemsCursor).some((entry) => entry.type === 'null')).toBe(true);
  expect(definition('SortDirection').enum).toEqual(expect.arrayContaining(['asc', 'desc']));
  expect(variants(definition('TurnItemsView')).flatMap((entry) => entry.enum ?? [])).toEqual(
    expect.arrayContaining(['notLoaded', 'summary', 'full']),
  );
  // CollaborationModeListParams is an empty-object RPC params type (never omitted on the wire).
  expect(top('CollaborationModeListParams').type).toBe('object');
  // ThreadItemsListAnchor supports item-anchored cursor `{ type: 'item', itemId }`.
  const itemAnchors = variants(definition('ThreadItemsListAnchor'));
  expect(itemAnchors.map(typeOf)).toContain('item');
  expect(properties(itemAnchors[0] ?? {})).toEqual(expect.arrayContaining(['type', 'itemId']));
  // CommandExecutionApprovalKind defines humanCommand (used to forbid acceptForSession).
  const cmdDefs = top('CommandExecutionRequestApprovalParams').definitions ?? {};
  const approvalKinds = variants(
    Definition.parse(Reflect.get(cmdDefs, 'CommandExecutionApprovalKind')),
  ).flatMap((entry) => entry.enum ?? []);
  expect(approvalKinds).toContain('humanCommand');

  // PermissionsRequestApprovalResponse defines turn|session grant scopes.
  const permRespDefs = top('PermissionsRequestApprovalResponse').definitions ?? {};
  expect(Definition.parse(Reflect.get(permRespDefs, 'PermissionGrantScope')).enum).toEqual([
    'turn',
    'session',
  ]);

  // McpServerElicitationRequestParams defines all 4 modes and response actions.
  const elicitationModes = variants(top('McpServerElicitationRequestParams')).map(
    (entry) => Definition.parse(Reflect.get(entry.properties ?? {}, 'mode') ?? {}).enum?.[0],
  );
  expect(elicitationModes).toEqual(['form', 'openai/form', 'openaiForm', 'url']);
  const elicitRespDefs = top('McpServerElicitationRequestResponse').definitions ?? {};
  expect(
    Definition.parse(Reflect.get(elicitRespDefs, 'McpServerElicitationAction')).enum,
  ).toEqual(['accept', 'decline', 'cancel']);

  // Thread list/unsubscribe enums match 0.171.0 schema.
  expect(definition('ThreadSortKey').enum).toEqual([
    'created_at',
    'updated_at',
    'recency_at',
    'section_position',
  ]);
  expect(definition('ThreadUnsubscribeStatus').enum).toEqual([
    'notLoaded',
    'notSubscribed',
    'unsubscribed',
  ]);
  expect(definition('ThreadSourceKind').enum).toEqual(
    expect.arrayContaining([
      'cli',
      'vscode',
      'exec',
      'appServer',
      'subAgent',
      'subAgentReview',
      'subAgentCompact',
      'subAgentThreadSpawn',
      'subAgentOther',
      'unknown',
    ]),
  );

  expect([
    ...CODEX_APPROVAL_REQUESTS,
    CODEX_PERMISSIONS_APPROVAL_REQUEST,
    CODEX_INPUT_REQUEST,
    CODEX_ELICITATION_REQUEST,
  ]).toEqual([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
  ]);
});

test('100% of codex-cli 0.171.0 ClientRequest, ServerRequest, ServerNotification, and ThreadItem schemas are classified and synchronized with driver constants', () => {
  const threadItemTypes = variants(definition('ThreadItem')).flatMap((entry) => {
    const typeName = Definition.parse(Reflect.get(entry.properties ?? {}, 'type') ?? {})
      .enum?.[0];
    return typeName !== undefined ? [typeName] : [];
  });

  // Exact live 0.171.0 surface counts.
  expect(fixture.ClientRequestMethods).toHaveLength(110);
  expect(fixture.ServerRequestMethods).toHaveLength(10);
  expect(fixture.ServerNotificationMethods).toHaveLength(87);
  expect(threadItemTypes).toHaveLength(19);

  // Every method, notification, and ThreadItem in 0.171.0 is classified with zero gaps or stale entries.
  expect(auditSchemaRegistry(fixture.ClientRequestMethods, CLIENT_REQUEST_REGISTRY)).toEqual({
    unclassified: [],
    stale: [],
  });
  expect(auditSchemaRegistry(fixture.ServerRequestMethods, SERVER_REQUEST_REGISTRY)).toEqual({
    unclassified: [],
    stale: [],
  });
  expect(
    auditSchemaRegistry(fixture.ServerNotificationMethods, SERVER_NOTIFICATION_REGISTRY),
  ).toEqual({
    unclassified: [],
    stale: [],
  });
  expect(auditSchemaRegistry(threadItemTypes, THREAD_ITEM_REGISTRY)).toEqual({
    unclassified: [],
    stale: [],
  });

  // Synchronize registry against live driver constants so code and drift table cannot diverge.
  const entriesWith = (
    registry: Readonly<Record<string, SchemaClassification>>,
    ...kinds: SchemaClassification[]
  ) =>
    Object.entries(registry)
      .filter(([, kind]) => kinds.includes(kind))
      .map(([name]) => name)
      .sort();

  expect(entriesWith(SERVER_REQUEST_REGISTRY, 'supported')).toEqual(
    [
      ...CODEX_APPROVAL_REQUESTS,
      CODEX_PERMISSIONS_APPROVAL_REQUEST,
      CODEX_INPUT_REQUEST,
      CODEX_ELICITATION_REQUEST,
    ].sort(),
  );
  for (const method of CODEX_PARSED_QUIET_NOTIFICATIONS) {
    expect(SERVER_NOTIFICATION_REGISTRY[method], method).toBe('quiet');
  }
  expect(
    [
      ...entriesWith(SERVER_NOTIFICATION_REGISTRY, 'supported'),
      ...CODEX_PARSED_QUIET_NOTIFICATIONS,
    ].sort(),
  ).toEqual(Object.keys(CodexNotificationParams).sort());
  expect(entriesWith(SERVER_NOTIFICATION_REGISTRY, 'opted-out')).toEqual(
    [...CODEX_OPTED_OUT_NOTIFICATIONS].sort(),
  );
  expect(entriesWith(SERVER_NOTIFICATION_REGISTRY, 'quiet', 'opted-out')).toEqual(
    [...CODEX_QUIET_NOTIFICATIONS].sort(),
  );
  expect(entriesWith(THREAD_ITEM_REGISTRY, 'supported')).toEqual([...CODEX_TOOL_ITEMS].sort());
  expect(entriesWith(THREAD_ITEM_REGISTRY, 'quiet')).toEqual([...CODEX_CONTENT_ITEMS].sort());

  // Negative controls: methods absent from codex-cli 0.171.0 ClientRequest must stay excluded.
  expect(fixture.ClientRequestMethods).not.toContain('thread/backgroundTerminals/list');
  expect(fixture.ClientRequestMethods).not.toContain('thread/backgroundTerminals/terminate');
  expect(fixture.ClientRequestMethods).not.toContain('thread/settings/update');

  // Negative control: auditSchemaRegistry fails loudly on any unclassified or stale entry.
  expect(
    auditSchemaRegistry(['known/method', 'future/unclassified'], {
      'known/method': 'supported',
      'removed/stale': 'quiet',
    }),
  ).toEqual({
    unclassified: ['future/unclassified'],
    stale: ['removed/stale'],
  });
});
