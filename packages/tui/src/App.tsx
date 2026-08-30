import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentConversationReader,
  AgentConversationSummary,
  AgentModelCatalog,
} from 'stitchkit/agent-runtime';
import { createAgentTuiBuiltinCommands } from './builtins';
import {
  type AgentTuiCommand,
  commandCompletions,
  composeTuiCommands,
  moveCommandCompletionSelection,
  resolveTuiCommandSubmission,
} from './commands';
import {
  createAgentTuiComposer,
  navigateAgentTuiHistory,
  setAgentTuiDraft,
  submitAgentTuiComposer,
} from './composer';
import type { AgentTuiTheme } from './config';
import type { AgentTuiController, AgentTuiControllerState } from './controller';
import { createTerminalFeedViewport, reduceTerminalFeedViewport } from './core';
import { isAgentTuiExitKey } from './keyboard';
import { searchAgentTuiModels } from './model-picker';
import { createAgentTuiConversationId } from './session';
import {
  type AgentTuiStatusLineFormatter,
  type AgentTuiStatusTone,
  defaultAgentTuiStatusLine,
} from './status-line';
import { type AgentTuiTranscriptEntry, projectAgentTuiTranscript } from './transcript';

type Dialog = 'help' | 'model' | 'sessions' | 'status' | 'tools' | 'skills' | 'permissions';

function isDialog(value: string): value is Dialog {
  return ['help', 'model', 'sessions', 'status', 'tools', 'skills', 'permissions'].includes(
    value,
  );
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roleLabel(role: AgentTuiTranscriptEntry['role']): string {
  if (role === 'you') return 'YOU';
  if (role === 'agent') return 'AGENT';
  if (role === 'tool') return 'TOOL';
  return 'SYSTEM';
}

function toneColor(tone: AgentTuiTranscriptEntry['tone'], theme: AgentTuiTheme): string {
  if (tone === 'muted') return theme.muted;
  if (tone === 'success') return theme.success;
  if (tone === 'danger') return theme.danger;
  if (tone === 'accent') return theme.accent;
  return theme.primary;
}

function statusToneColor(tone: AgentTuiStatusTone | undefined, theme: AgentTuiTheme): string {
  return theme[tone ?? 'primary'];
}

function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1_000)}K`;
}

function activeRunId(state: AgentTuiControllerState): string | undefined {
  return state.snapshot.runs.find(
    ({ state: runState }) => runState === 'running' || runState === 'interrupt_requested',
  )?.id;
}

export function AgentTuiApp<CONTEXT>({
  controller,
  catalog,
  conversations,
  commands: customCommands = [],
  theme,
  workspace,
  statusLine,
  sessionId,
  title,
  onConversationChange,
  onExit,
}: {
  controller: AgentTuiController<CONTEXT>;
  catalog: AgentModelCatalog;
  conversations?: AgentConversationReader;
  commands?: readonly AgentTuiCommand[];
  theme: AgentTuiTheme;
  workspace: string;
  statusLine?: AgentTuiStatusLineFormatter | false;
  sessionId: string;
  title: string;
  onConversationChange(
    conversationId: string,
    reason: 'new' | 'clear' | 'resume',
  ): void | Promise<void>;
  onExit(): void | Promise<void>;
}) {
  const dimensions = useTerminalDimensions();
  const [state, setState] = useState(controller.state());
  const [dialog, setDialog] = useState<Dialog>();
  const [modelQuery, setModelQuery] = useState('');
  const [modelSearchFocused, setModelSearchFocused] = useState(true);
  const [composer, setComposer] = useState(createAgentTuiComposer);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [dismissedCompletionDraft, setDismissedCompletionDraft] = useState<string>();
  const draft = composer.draft;
  const [localNotice, setLocalNotice] = useState<string>();
  const [hiddenBefore, setHiddenBefore] = useState(0);
  const [sessions, setSessions] = useState<readonly AgentConversationSummary[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [viewport, setViewport] = useState(() => createTerminalFeedViewport(0, 1));
  const previousTranscriptSize = useRef(0);
  const previousConversationId = useRef(state.conversationId);
  const composerRef = useRef<TextareaRenderable | null>(null);
  const transcriptRef = useRef<ScrollBoxRenderable | null>(null);
  const compact = dimensions.width < 90;
  const commands = useMemo(
    () => composeTuiCommands(createAgentTuiBuiltinCommands(), customCommands),
    [customCommands],
  );
  const entries = useMemo(
    () => projectAgentTuiTranscript(state.snapshot).slice(hiddenBefore),
    [hiddenBefore, state.snapshot],
  );
  const streamingRows = useMemo(
    () =>
      Object.values(state.streaming).reduce(
        (total, text) => total + Math.max(1, text.split('\n').length),
        0,
      ),
    [state.streaming],
  );
  const transcriptUnits = entries.length + streamingRows;
  const completions = useMemo(
    () =>
      dismissedCompletionDraft === draft
        ? []
        : commandCompletions(draft, commands).slice(0, 5),
    [commands, dismissedCompletionDraft, draft],
  );
  const runId = activeRunId(state);
  const activity = state.pendingApproval ? 'APPROVAL' : runId ? 'RUNNING' : 'READY';
  const selectedModel = catalog.models.find(({ id }) => id === state.selectedModelId);
  const statusRows = useMemo(() => {
    if (statusLine === false) return [];
    return (statusLine ?? defaultAgentTuiStatusLine)({
      title,
      workspace,
      activity,
      sessionId,
      conversationId: state.conversationId,
      ...(selectedModel && { model: selectedModel }),
      snapshot: state.snapshot,
    });
  }, [
    activity,
    selectedModel,
    sessionId,
    state.conversationId,
    state.snapshot,
    statusLine,
    title,
    workspace,
  ]);

  useEffect(() => controller.subscribe(setState), [controller]);

  useEffect(() => {
    const capacity = Math.max(1, dimensions.height - 12);
    const previous = previousTranscriptSize.current;
    const conversationChanged = previousConversationId.current !== state.conversationId;
    previousTranscriptSize.current = transcriptUnits;
    previousConversationId.current = state.conversationId;
    setViewport((current) => {
      if (conversationChanged || transcriptUnits < previous) {
        return createTerminalFeedViewport(transcriptUnits, capacity);
      }
      const appended = reduceTerminalFeedViewport(current, {
        type: 'append',
        count: transcriptUnits - previous,
      });
      return reduceTerminalFeedViewport(appended, { type: 'resize', capacity });
    });
  }, [dimensions.height, state.conversationId, transcriptUnits]);

  useEffect(() => {
    if (dialog !== 'sessions' || !conversations) return;
    void conversations
      .list({ limit: 50 })
      .then((page) => {
        setSessions(page.items);
        setSessionCursor(page.nextCursor);
      })
      .catch((error: unknown) => setLocalNotice(errorMessage(error)));
  }, [conversations, dialog]);

  const applyOutcome = useCallback(
    async (outcome: Awaited<ReturnType<AgentTuiCommand['execute']>>) => {
      if (outcome.type === 'dialog') {
        setDialog(isDialog(outcome.dialog) ? outcome.dialog : 'help');
        if (outcome.dialog === 'model') {
          setModelQuery(outcome.query ?? '');
          setModelSearchFocused((outcome.query ?? '').length === 0);
        }
        return;
      }
      if (outcome.type === 'notice') {
        setLocalNotice(outcome.message);
        return;
      }
      if (outcome.type === 'submit') {
        await controller.submit(outcome.text);
        return;
      }
      if (outcome.action === 'interrupt') {
        await controller.interrupt();
      } else if (outcome.action === 'new-conversation') {
        const conversationId = createAgentTuiConversationId();
        await controller.switchConversation(conversationId);
        await onConversationChange(conversationId, 'new');
        setHiddenBefore(0);
      } else if (outcome.action === 'clear-conversation') {
        const conversationId = createAgentTuiConversationId();
        await controller.switchConversation(conversationId);
        await onConversationChange(conversationId, 'clear');
        setHiddenBefore(0);
      } else if (outcome.action === 'quit') {
        await onExit();
      }
    },
    [controller, onConversationChange, onExit],
  );

  const submit = useCallback(async () => {
    const withCurrentText = setAgentTuiDraft(
      composer,
      composerRef.current?.plainText ?? composer.draft,
    );
    const submitted = submitAgentTuiComposer(withCurrentText);
    if (!submitted.text) return;
    const text = submitted.text;
    const resolution = resolveTuiCommandSubmission(
      text,
      commands,
      completionIndex,
      dismissedCompletionDraft === text,
    );
    try {
      if (resolution.type === 'prompt') {
        await controller.submit(resolution.text);
      } else {
        const context = {
          conversationId: state.conversationId,
          ...(runId && { activeRunId: runId }),
        };
        if (resolution.command.available && !resolution.command.available(context)) {
          setLocalNotice(`/${resolution.command.name} is not available in the current state.`);
          return;
        }
        await applyOutcome(
          await resolution.command.execute(resolution.argumentsText, context),
        );
      }
      composerRef.current?.setText('');
      setComposer(submitted.state);
      setDismissedCompletionDraft(undefined);
    } catch (error) {
      setLocalNotice(error instanceof Error ? error.message : String(error));
    }
  }, [
    applyOutcome,
    commands,
    completionIndex,
    composer,
    controller,
    dismissedCompletionDraft,
    runId,
    state.conversationId,
  ]);

  useKeyboard((key) => {
    if (isAgentTuiExitKey(key)) {
      void Promise.resolve(onExit()).catch((error: unknown) =>
        setLocalNotice(errorMessage(error)),
      );
      return;
    }
    if (state.pendingApproval && key.name === 'y') {
      void controller
        .respondToApproval(true)
        .catch((error: unknown) => setLocalNotice(errorMessage(error)));
      return;
    }
    if (state.pendingApproval && (key.name === 'n' || key.name === 'escape')) {
      void controller
        .respondToApproval(false, 'Denied from the terminal host')
        .catch((error: unknown) => setLocalNotice(errorMessage(error)));
      return;
    }
    if (dialog && key.name === 'escape') {
      setDialog(undefined);
      return;
    }
    if (dialog === 'model' && key.name === 'tab') {
      key.preventDefault();
      key.stopPropagation();
      setModelSearchFocused((focused) => !focused);
      return;
    }
    if (!dialog && completions.length > 0 && key.name === 'escape') {
      key.preventDefault();
      key.stopPropagation();
      setDismissedCompletionDraft(draft);
      return;
    }
    if (!dialog && completions.length > 0 && (key.name === 'up' || key.name === 'down')) {
      key.preventDefault();
      key.stopPropagation();
      const direction = key.name === 'up' ? -1 : 1;
      setCompletionIndex((current) =>
        moveCommandCompletionSelection(
          current,
          direction === -1 ? 'previous' : 'next',
          completions.length,
        ),
      );
      return;
    }
    if (!dialog && key.name === 'tab' && completions[0]) {
      key.preventDefault();
      key.stopPropagation();
      const selected = completions[completionIndex] ?? completions[0];
      const next = setAgentTuiDraft(composer, `/${selected.name} `);
      composerRef.current?.setText(next.draft);
      setComposer(next);
      setCompletionIndex(0);
      setDismissedCompletionDraft(undefined);
      return;
    }
    if (!dialog && key.name === 'pageup') {
      transcriptRef.current?.scrollBy(-0.8, 'viewport');
      setViewport((current) =>
        reduceTerminalFeedViewport(current, { type: 'page', pages: -1 }),
      );
    }
    if (!dialog && key.name === 'pagedown') {
      transcriptRef.current?.scrollBy(0.8, 'viewport');
      setViewport((current) =>
        reduceTerminalFeedViewport(current, { type: 'page', pages: 1 }),
      );
    }
    if (!dialog && key.option && (key.name === 'up' || key.name === 'down')) {
      const lines = key.name === 'up' ? -1 : 1;
      transcriptRef.current?.scrollBy(lines, 'step');
      setViewport((current) => reduceTerminalFeedViewport(current, { type: 'scroll', lines }));
    }
    if (!dialog && key.name === 'home' && key.ctrl) {
      transcriptRef.current?.scrollTo(0);
      setViewport((current) => reduceTerminalFeedViewport(current, { type: 'home' }));
    }
    if (!dialog && key.name === 'end' && key.ctrl) {
      transcriptRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
      setViewport((current) => reduceTerminalFeedViewport(current, { type: 'end' }));
    }
    if (!dialog && key.ctrl && (key.name === 'up' || key.name === 'down')) {
      const next = navigateAgentTuiHistory(composer, key.name === 'up' ? 'older' : 'newer');
      composerRef.current?.setText(next.draft);
      setComposer(next);
    }
  });

  const visibleModels = searchAgentTuiModels(catalog, modelQuery);
  const modelOptions = visibleModels.models.map((model) => {
    const coding = model.metrics.find(({ metric }) => metric === 'coding');
    const evidence = coding ?? model.popularity;
    return {
      name: model.name,
      description: `${model.id} · ${formatContext(model.descriptor.contextWindow)} · #${model.popularity?.rank ?? '—'} weekly${coding ? ` · coding ${coding.value}` : ''}${evidence ? ` · ${evidence.source} @ ${evidence.observedAt.slice(0, 10)}` : ''}`,
    };
  });
  const selectedModelIndex = Math.max(
    0,
    visibleModels.models.findIndex(({ id }) => id === state.selectedModelId),
  );

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
      }}
    >
      <box
        style={{
          height: 1,
          paddingLeft: compact ? 1 : 2,
          paddingRight: compact ? 1 : 2,
          alignItems: 'center',
          flexDirection: 'row',
        }}
      >
        <text fg={theme.accent}>
          <strong>◆ {title}</strong>
        </text>
        {!compact ? (
          <text fg={theme.muted}> · {selectedModel?.name ?? state.selectedModelId}</text>
        ) : null}
      </box>

      <scrollbox
        ref={transcriptRef}
        focused={!dialog && !state.pendingApproval}
        stickyScroll={viewport.followTail}
        stickyStart='bottom'
        style={{
          flexGrow: 1,
          paddingLeft: compact ? 1 : 2,
          paddingRight: compact ? 1 : 2,
          paddingTop: 1,
          contentOptions: { flexDirection: 'column' },
          scrollbarOptions: { visible: !compact },
        }}
      >
        {entries.length === 0 ? (
          <box style={{ flexDirection: 'column', paddingTop: 1 }}>
            <text fg={theme.primary}>
              <strong>What do you want to build?</strong>
            </text>
            <text fg={theme.muted}>Type / for commands</text>
          </box>
        ) : (
          entries.map((entry) => (
            <box key={entry.id} style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text fg={entry.role === 'you' ? theme.accent : theme.muted}>
                <strong>{roleLabel(entry.role)}</strong>
              </text>
              <text fg={toneColor(entry.tone, theme)}>{entry.text}</text>
            </box>
          ))
        )}
        {Object.entries(state.streaming).map(([streamRunId, text]) => (
          <box key={streamRunId} style={{ flexDirection: 'column', marginBottom: 1 }}>
            <text fg={theme.muted}>
              <strong>AGENT · STREAMING</strong>
            </text>
            <text fg={theme.primary}>{text}</text>
          </box>
        ))}
      </scrollbox>

      {state.pendingApproval ? (
        <box
          title=' APPROVAL '
          titleColor={theme.warning}
          style={{
            height: 7,
            marginLeft: compact ? 0 : 2,
            marginRight: compact ? 0 : 2,
            border: true,
            borderColor: theme.warning,
            backgroundColor: theme.panelRaised,
            padding: 1,
            flexDirection: 'column',
          }}
        >
          <text fg={theme.primary}>
            <strong>{state.pendingApproval.toolName}</strong>
          </text>
          <text fg={theme.muted}>
            {JSON.stringify(state.pendingApproval.input).slice(0, 240)}
          </text>
          <text fg={theme.warning}>Y approve once · N / Esc deny</text>
        </box>
      ) : (
        <box style={{ flexDirection: 'column' }}>
          {completions.length > 0 ? (
            <box
              style={{
                maxHeight: 7,
                marginLeft: compact ? 1 : 2,
                marginRight: compact ? 1 : 2,
                border: ['bottom'],
                borderColor: theme.border,
                flexDirection: 'column',
              }}
            >
              {completions.map((command, index) => (
                <box
                  key={command.name}
                  style={{
                    paddingLeft: 1,
                    ...(index === completionIndex && {
                      backgroundColor: theme.panelRaised,
                    }),
                  }}
                >
                  <text fg={index === completionIndex ? theme.primary : theme.muted}>
                    <span fg={theme.accent}>
                      {index === completionIndex ? '›' : ' '} /{command.name}
                    </span>{' '}
                    {command.description}
                  </text>
                </box>
              ))}
            </box>
          ) : null}
          <box
            style={{
              height: 3,
              marginLeft: compact ? 1 : 2,
              marginRight: compact ? 1 : 2,
              border: ['top', 'bottom'],
              borderColor: dialog ? theme.border : theme.borderActive,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: 'row',
            }}
          >
            <text fg={dialog ? theme.muted : theme.accent}>› </text>
            <textarea
              ref={composerRef}
              focused={!dialog}
              placeholder='Message the agent or type / for commands…'
              initialValue={draft}
              wrapMode='word'
              keyBindings={[
                { name: 'return', action: 'submit' },
                { name: 'return', shift: true, action: 'newline' },
              ]}
              onContentChange={() => {
                const text = composerRef.current?.plainText ?? '';
                setComposer((current) => setAgentTuiDraft(current, text));
                setCompletionIndex(0);
                setDismissedCompletionDraft(undefined);
              }}
              onSubmit={() => void submit()}
              style={{ width: '100%', height: '100%' }}
            />
          </box>
        </box>
      )}

      {localNotice || state.notice || viewport.unseen > 0 ? (
        <box style={{ height: 1, paddingLeft: compact ? 1 : 2, paddingRight: 1 }}>
          <text fg={localNotice || state.notice ? theme.danger : theme.accent}>
            {localNotice ?? state.notice?.message ?? `${viewport.unseen} new messages`}
          </text>
        </box>
      ) : null}

      {statusRows.length > 0 ? (
        <box
          style={{
            height: statusRows.length,
            paddingLeft: compact ? 1 : 2,
            paddingRight: 1,
            flexDirection: 'column',
          }}
        >
          {statusRows.map((row, rowIndex) => (
            <text key={`status-${rowIndex}`}>
              {row.map((segment, segmentIndex) => (
                <span
                  key={`${segment.text}-${segmentIndex}`}
                  fg={statusToneColor(segment.tone, theme)}
                  bg={segmentIndex % 2 === 0 ? theme.panel : theme.panelRaised}
                >
                  {' '}
                  {segment.text}{' '}
                </span>
              ))}
            </text>
          ))}
        </box>
      ) : null}

      {dialog ? (
        <box
          title={` ${dialog.toUpperCase()} `}
          titleColor={theme.accent}
          style={{
            position: 'absolute',
            left: compact ? 1 : Math.max(4, Math.floor(dimensions.width * 0.12)),
            right: compact ? 1 : Math.max(4, Math.floor(dimensions.width * 0.12)),
            top: compact ? 2 : 4,
            bottom: compact ? 2 : 4,
            border: true,
            borderColor: theme.borderActive,
            backgroundColor: theme.panelRaised,
            padding: 1,
            flexDirection: 'column',
          }}
        >
          {dialog === 'model' ? (
            <box style={{ flexDirection: 'column', width: '100%', height: '100%' }}>
              <text fg={theme.muted}>
                Search the full catalog · showing {visibleModels.models.length} of{' '}
                {visibleModels.total} matches · Tab switches search/list
              </text>
              <box
                style={{
                  height: 3,
                  border: true,
                  borderColor: modelSearchFocused ? theme.borderActive : theme.border,
                  paddingLeft: 1,
                  paddingRight: 1,
                }}
              >
                <input
                  focused={modelSearchFocused}
                  value={modelQuery}
                  placeholder='Filter by model, provider or capability…'
                  onInput={setModelQuery}
                  onSubmit={() => setModelSearchFocused(false)}
                  style={{ width: '100%' }}
                />
              </box>
              <select
                focused={!modelSearchFocused}
                options={modelOptions}
                selectedIndex={selectedModelIndex}
                showDescription
                showScrollIndicator
                wrapSelection
                backgroundColor={theme.panelRaised}
                textColor={theme.primary}
                descriptionColor={theme.muted}
                selectedBackgroundColor={theme.accent}
                selectedTextColor={theme.canvas}
                selectedDescriptionColor={theme.canvas}
                style={{ width: '100%', flexGrow: 1 }}
                onSelect={(index) => {
                  const model = visibleModels.models[index];
                  if (!model) return;
                  void controller
                    .selectModel(model.id)
                    .then(() => setDialog(undefined))
                    .catch((error: unknown) => setLocalNotice(errorMessage(error)));
                }}
              />
            </box>
          ) : dialog === 'sessions' ? (
            conversations ? (
              <select
                focused
                options={sessions.map((session) => ({
                  name: session.conversationId,
                  description: `${session.activeRuns > 0 ? `${session.activeRuns} active · ` : ''}${session.preview}`,
                }))}
                showDescription
                showScrollIndicator
                backgroundColor={theme.panelRaised}
                textColor={theme.primary}
                descriptionColor={theme.muted}
                selectedBackgroundColor={theme.accent}
                selectedTextColor={theme.canvas}
                selectedDescriptionColor={theme.canvas}
                style={{ width: '100%', height: '100%' }}
                onSelect={(index) => {
                  const selected = sessions[index];
                  if (!selected) return;
                  void controller
                    .switchConversation(selected.conversationId)
                    .then(async () => {
                      await onConversationChange(selected.conversationId, 'resume');
                      setDialog(undefined);
                      setHiddenBefore(0);
                    })
                    .catch((error: unknown) => setLocalNotice(errorMessage(error)));
                }}
              />
            ) : (
              <text fg={theme.muted}>This host does not provide a conversation catalog.</text>
            )
          ) : dialog === 'help' ? (
            <scrollbox
              focused
              style={{ flexGrow: 1, contentOptions: { flexDirection: 'column' } }}
            >
              {commands.map((command) => (
                <text key={command.name} fg={theme.primary}>
                  <span fg={theme.accent}>/{command.name}</span> {command.description}
                </text>
              ))}
            </scrollbox>
          ) : dialog === 'status' ? (
            <box style={{ flexDirection: 'column' }}>
              <text fg={theme.primary}>Session {sessionId}</text>
              <text fg={theme.primary}>Conversation {state.conversationId}</text>
              <text fg={theme.primary}>Model {state.selectedModelId}</text>
              <text fg={theme.primary}>Run {runId ?? 'idle'}</text>
              <text fg={theme.muted}>
                External clients submit through this host's controller.
              </text>
            </box>
          ) : dialog === 'tools' ? (
            <box style={{ flexDirection: 'column' }}>
              {[
                ...new Set(
                  entries
                    .filter(({ role }) => role === 'tool')
                    .map(({ text }) => text.split(' ')[1])
                    .filter(isString),
                ),
              ].map((name) => (
                <text key={name} fg={theme.primary}>
                  {name}
                </text>
              ))}
              <text fg={theme.muted}>Direct tools retain their own durable identity.</text>
            </box>
          ) : dialog === 'permissions' ? (
            <box style={{ flexDirection: 'column' }}>
              <text fg={theme.primary}>Approval decisions are per exact tool call.</text>
              <text fg={theme.muted}>
                Sandbox enforcement is supplied and reported by the embedding host.
              </text>
            </box>
          ) : (
            <box style={{ flexDirection: 'column' }}>
              <text fg={theme.primary}>
                Skills and resources are discovered lazily by the harness.
              </text>
              <text fg={theme.muted}>
                The model reads exact content through the direct read_resource tool.
              </text>
            </box>
          )}
          {dialog === 'sessions' && sessionCursor ? (
            <text fg={theme.muted}>More conversations are available.</text>
          ) : null}
          <text fg={theme.muted}>Esc close</text>
        </box>
      ) : null}
    </box>
  );
}
