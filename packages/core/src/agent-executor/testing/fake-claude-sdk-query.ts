import type {
  AccountInfo,
  McpServerStatus,
  McpSetServersResult,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKControlSetPermissionModeResponse,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { linkAbortSignals, untilAborted } from '../../internal/abort-race';
import type { ClaudeSdkQuery, ClaudeSdkRun } from '../claude-sdk/driver';

/** Recorded live control invocation observed on {@link FakeClaudeSdkQueryHarness}. */
export interface FakeClaudeSdkRecordedCall {
  /** Control method name invoked by the driver (`interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`, `rewindFiles`, `close`, etc.). */
  readonly method: string;
  /** Positional arguments passed to the control method. */
  readonly args: readonly unknown[];
}

/** Imperative controller handed to scripted turns and `onRun` callbacks in {@link createFakeClaudeSdkQuery}. */
export interface FakeClaudeSdkRunController {
  /** SDK options passed when this query run was created. */
  readonly options: Options | undefined;
  /** User messages pulled from the `prompt` async iterable for this run. */
  readonly promptMessages: readonly SDKUserMessage[];
  /** Emit one raw Claude SDK stream record to the driver's drain loop. */
  emit(record: unknown): void;
  /** Trigger the driver's `options.canUseTool` callback with a real `AbortSignal` and `toolUseID`. */
  askPermission(
    toolName: string,
    input: Record<string, unknown>,
    options?: {
      readonly toolUseID?: string | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly requestId?: string | undefined;
      readonly decisionReason?: string | undefined;
      readonly blockedPath?: string | undefined;
      readonly title?: string | undefined;
      readonly displayName?: string | undefined;
      readonly description?: string | undefined;
      readonly agentID?: string | undefined;
      readonly defaultToNo?: boolean | undefined;
      readonly suppressAlwaysAllowRule?: boolean | undefined;
    },
  ): Promise<PermissionResult | null>;
  /** End the run's async iterable cleanly (simulates unexpected idle or mid-turn query exit). */
  end(): void;
  /** Fail the run's async iterable with `error`. */
  fail(error: unknown): void;
}

/** One scripted turn driven by {@link createFakeClaudeSdkQuery}: static record list or imperative handler. */
export type FakeClaudeSdkScriptedTurn =
  | { readonly records: readonly unknown[] }
  | ((
      message: SDKUserMessage,
      controller: FakeClaudeSdkRunController,
    ) => Promise<void> | void);

/** Configuration for {@link createFakeClaudeSdkQuery}. */
export interface FakeClaudeSdkQueryConfig {
  /** Ordered turns executed as user messages arrive on the query's `prompt` iterable. */
  readonly turns?: readonly FakeClaudeSdkScriptedTurn[] | undefined;
  /** Optional hook invoked as soon as each `ClaudeSdkRun` is created (before prompt messages arrive). */
  readonly onRun?:
    | ((controller: FakeClaudeSdkRunController) => Promise<void> | void)
    | undefined;
  /** Canned `initializationResult()` response. */
  readonly initializationResult?: SDKControlInitializeResponse | undefined;
  /** Canned `supportedModels()` list. */
  readonly models?: readonly ModelInfo[] | undefined;
  /** Canned `supportedCommands()` list. */
  readonly commands?: readonly SlashCommand[] | undefined;
  /** Canned `accountInfo()` response. */
  readonly account?: AccountInfo | undefined;
  /** Canned `mcpServerStatus()` list. */
  readonly mcpServers?: readonly McpServerStatus[] | undefined;
  /** Canned `getContextUsage()` response. */
  readonly contextUsage?: SDKControlGetContextUsageResponse | undefined;
  /**
   * Optional `get_usage` response or factory. When omitted, the experimental usage method is NOT
   * attached to the fake query (so `readUsage()` reports `{ supported: false }`).
   */
  readonly usage?:
    | SDKControlGetUsageResponse
    | (() => Promise<SDKControlGetUsageResponse> | SDKControlGetUsageResponse)
    | undefined;
  /** Optional custom `setPermissionMode` response resolver (defaults to `{ mode }`). */
  readonly onSetPermissionMode?:
    | ((
        mode: PermissionMode,
      ) =>
        | Promise<SDKControlSetPermissionModeResponse | undefined>
        | SDKControlSetPermissionModeResponse
        | undefined)
    | undefined;
  /** Canned `rewindFiles()` response (defaults to `{ canRewind: true }`). */
  readonly rewindFilesResult?: RewindFilesResult | undefined;
  /** Canned `setMcpServers()` response (defaults to `{ added: [], removed: [], errors: {} }`). */
  readonly setMcpServersResult?: McpSetServersResult | undefined;
}

/** Harness returned by {@link createFakeClaudeSdkQuery} for E2E tests over `createClaudeSdkDriver`. */
export interface FakeClaudeSdkQueryHarness {
  /** Drop-in `ClaudeSdkQuery` implementation passed as `createClaudeSdkDriver({ query })`. */
  readonly query: ClaudeSdkQuery;
  /** Recorded control method calls across all query runs in chronological order. */
  readonly calls: readonly FakeClaudeSdkRecordedCall[];
  /** All user messages consumed from `prompt` across all runs in chronological order. */
  readonly promptMessages: readonly SDKUserMessage[];
  /** Controllers for every `ClaudeSdkRun` created by this harness. */
  readonly runs: readonly FakeClaudeSdkRunController[];
}

function createRecordQueue(onFinish: () => void) {
  const buffered: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: { readonly error: unknown } | undefined;

  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };

  return {
    push(record: unknown) {
      if (done) return;
      buffered.push(record);
      notify();
    },
    end() {
      if (done) return;
      done = true;
      onFinish();
      notify();
    },
    fail(error: unknown) {
      if (done) return;
      done = true;
      failure = { error };
      onFinish();
      notify();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        if (buffered.length > 0) {
          yield buffered.shift();
          continue;
        }
        if (failure !== undefined) throw failure.error;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

type RecordQueue = ReturnType<typeof createRecordQueue>;

function buildCanUseToolOptions(
  signal: AbortSignal,
  permOptions: Parameters<FakeClaudeSdkRunController['askPermission']>[2],
): Parameters<NonNullable<Options['canUseTool']>>[2] {
  const result: Parameters<NonNullable<Options['canUseTool']>>[2] = {
    signal,
    toolUseID: permOptions?.toolUseID ?? 'tool-1',
    requestId: permOptions?.requestId ?? 'req-1',
  };
  if (permOptions?.decisionReason !== undefined)
    result.decisionReason = permOptions.decisionReason;
  if (permOptions?.blockedPath !== undefined) result.blockedPath = permOptions.blockedPath;
  if (permOptions?.title !== undefined) result.title = permOptions.title;
  if (permOptions?.displayName !== undefined) result.displayName = permOptions.displayName;
  if (permOptions?.description !== undefined) result.description = permOptions.description;
  if (permOptions?.agentID !== undefined) result.agentID = permOptions.agentID;
  if (permOptions?.defaultToNo !== undefined) result.defaultToNo = permOptions.defaultToNo;
  if (permOptions?.suppressAlwaysAllowRule !== undefined) {
    result.suppressAlwaysAllowRule = permOptions.suppressAlwaysAllowRule;
  }
  return result;
}

function createFakeRunController(
  options: Options | undefined,
  runMessages: SDKUserMessage[],
  output: RecordQueue,
): FakeClaudeSdkRunController {
  return {
    options,
    promptMessages: runMessages,
    emit(entry) {
      output.push(entry);
    },
    async askPermission(toolName, input, permOptions) {
      if (options?.canUseTool === undefined) {
        throw new Error(
          '[stitchkit] FakeClaudeSdkRunController.askPermission: driver did not supply canUseTool',
        );
      }
      const abortController = new AbortController();
      const forwardAbort = () => abortController.abort();
      const parentSignal = options.abortController?.signal;
      const customSignal = permOptions?.signal;
      if (parentSignal?.aborted || customSignal?.aborted) {
        abortController.abort();
      } else {
        parentSignal?.addEventListener('abort', forwardAbort, { once: true });
        customSignal?.addEventListener('abort', forwardAbort, { once: true });
      }
      try {
        return await options.canUseTool(
          toolName,
          input,
          buildCanUseToolOptions(abortController.signal, permOptions),
        );
      } finally {
        parentSignal?.removeEventListener('abort', forwardAbort);
        customSignal?.removeEventListener('abort', forwardAbort);
      }
    },
    end() {
      output.end();
    },
    fail(error) {
      output.fail(error);
    },
  };
}

function createFakeRunObject(
  config: FakeClaudeSdkQueryConfig,
  output: RecordQueue,
  record: (method: string, args: readonly unknown[]) => void,
  close: () => void,
): ClaudeSdkRun {
  return {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    async interrupt() {
      record('interrupt', []);
    },
    close,
    async setModel(model) {
      record('setModel', [model]);
    },
    async setPermissionMode(mode) {
      record('setPermissionMode', [mode]);
      return config.onSetPermissionMode !== undefined
        ? config.onSetPermissionMode(mode)
        : { mode };
    },
    async applyFlagSettings(settings) {
      record('applyFlagSettings', [settings]);
    },
    async initializationResult() {
      record('initializationResult', []);
      return (
        config.initializationResult ?? {
          commands: [...(config.commands ?? [])],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [...(config.models ?? [])],
          account: config.account ?? {},
        }
      );
    },
    async supportedModels() {
      record('supportedModels', []);
      return [...(config.models ?? [])];
    },
    async supportedCommands() {
      record('supportedCommands', []);
      return [...(config.commands ?? [])];
    },
    async accountInfo() {
      record('accountInfo', []);
      return config.account ?? {};
    },
    async getContextUsage(opts) {
      record('getContextUsage', [opts]);
      return (
        config.contextUsage ?? {
          categories: [],
          totalTokens: 0,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 0,
          gridRows: [],
          model: 'claude-sonnet-4-6',
          isAutoCompactEnabled: true,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          apiUsage: null,
        }
      );
    },
    ...(config.usage !== undefined && {
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts) {
        record('usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', [opts]);
        const provider = config.usage;
        if (typeof provider === 'function') return provider();
        if (provider !== undefined) return provider;
        throw new Error('Fake usage provider missing');
      },
    }),
    async mcpServerStatus() {
      record('mcpServerStatus', []);
      return [...(config.mcpServers ?? [])];
    },
    async setMcpServers(servers) {
      record('setMcpServers', [servers]);
      return config.setMcpServersResult ?? { added: [], removed: [], errors: {} };
    },
    async toggleMcpServer(serverName, enabled) {
      record('toggleMcpServer', [serverName, enabled]);
    },
    async reconnectMcpServer(serverName) {
      record('reconnectMcpServer', [serverName]);
    },
    async stopTask(taskId) {
      record('stopTask', [taskId]);
    },
    async backgroundTasks(toolUseId) {
      record('backgroundTasks', [toolUseId]);
      return true;
    },
    async rewindFiles(userMessageId, rewindOptions) {
      record('rewindFiles', [userMessageId, rewindOptions]);
      return config.rewindFilesResult ?? { canRewind: true };
    },
  };
}

/**
 * Create a scripted in-process {@link ClaudeSdkQuery} harness for consumer E2E tests against real
 * `createClaudeSdkDriver`, keeping runs open across multiple turns and supporting `canUseTool`,
 * live control recording, and non-inference `probeCapabilities`.
 */
export function createFakeClaudeSdkQuery(
  config: FakeClaudeSdkQueryConfig = {},
): FakeClaudeSdkQueryHarness {
  const calls: FakeClaudeSdkRecordedCall[] = [];
  const promptMessages: SDKUserMessage[] = [];
  const runs: FakeClaudeSdkRunController[] = [];
  let turnCursor = 0;

  const record = (method: string, args: readonly unknown[]) => {
    calls.push({ method, args });
  };

  const query: ClaudeSdkQuery = ({ prompt, options }) => {
    const lifetime = new AbortController();
    const input = linkAbortSignals(options?.abortController?.signal, lifetime.signal);
    const output = createRecordQueue(() => {
      lifetime.abort();
      input.release();
    });
    const runMessages: SDKUserMessage[] = [];
    let closed = false;

    const controller = createFakeRunController(options, runMessages, output);
    runs.push(controller);

    const signal = input.signal;
    const close = () => {
      if (closed) return;
      closed = true;
      record('close', []);
      output.end();
    };

    if (signal.aborted) output.end();
    else signal.addEventListener('abort', () => output.end(), { once: true });

    if (config.onRun !== undefined && !signal.aborted) {
      void Promise.resolve()
        .then(() => (signal.aborted ? undefined : config.onRun?.(controller)))
        .catch((error: unknown) => output.fail(error));
    }

    void (async () => {
      if (signal.aborted) return;
      let iterator: AsyncIterator<SDKUserMessage> | undefined;
      let exhausted = false;
      try {
        iterator = prompt[Symbol.asyncIterator]();
        while (!signal.aborted) {
          const next = await untilAborted(iterator.next(), signal);
          if (next.aborted || signal.aborted) break;
          if (next.value.done) {
            exhausted = true;
            break;
          }
          const message = next.value.value;
          runMessages.push(message);
          promptMessages.push(message);
          const scripted = config.turns?.[turnCursor];
          turnCursor += 1;
          if (scripted === undefined) continue;
          if (typeof scripted === 'function') {
            await untilAborted(Promise.resolve(scripted(message, controller)), signal);
          } else {
            for (const entry of scripted.records) output.push(entry);
          }
        }
      } catch (error) {
        output.fail(error);
      } finally {
        if (!exhausted && iterator?.return) {
          try {
            await iterator.return();
          } catch (error) {
            output.fail(error);
          }
        }
      }
    })();

    return createFakeRunObject(config, output, record, close);
  };

  return { query, calls, promptMessages, runs };
}
