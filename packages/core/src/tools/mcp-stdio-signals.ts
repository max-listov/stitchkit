import {
  DEFAULT_PROCESS_SIGNALS,
  defaultSignalSource,
  guardSignalCallback,
  reportSignalError,
} from '../server/process-signal-common';
import type { ProcessSignalName, SignalSource } from '../server/process-signals';
import type { McpStdioHandle } from './mcp-stdio';

export type StdioProcessSignalsErrorPhase = 'prepare' | 'close' | 'complete';

export interface StdioProcessSignalsOptions {
  /** Defaults to `['SIGINT', 'SIGTERM']`; duplicates are ignored. */
  signals?: readonly ProcessSignalName[];
  signalSource?: SignalSource;
  /** Runs before the transport closes. Failure is reported and close still runs. */
  onClose?: (signal: ProcessSignalName) => void | Promise<void>;
  /** Runs after the official stdio handle has closed. */
  onComplete?: () => void | Promise<void>;
  onError?: (phase: StdioProcessSignalsErrorPhase, error: unknown) => void;
  /** A later signal cannot force stdio close, so it always means escalation. */
  onRepeatedSignal?: (signal: ProcessSignalName) => void;
  /** Called when another listener prevents restoration of the default disposition. */
  onEscalationBlocked?: (signal: ProcessSignalName) => void;
}

export interface StdioProcessSignalsBinding {
  /** Resolves after close, or `undefined` when an idle binding is removed. */
  readonly promise: Promise<void>;
  /** Remove listeners. Idempotent; does not cancel an already-running close. */
  close(): void;
}

export type StdioCloseTarget = Pick<McpStdioHandle, 'close'>;

const bound = new WeakSet<StdioCloseTarget>();

/**
 * Bind process signals to one close-only stdio MCP handle.
 *
 * Unlike managed HTTP shutdown, stdio exposes no deadline or force method. A
 * later signal therefore removes this binding and restores the signal's default
 * disposition instead of pretending an AbortSignal can affect `close()`.
 */
export function bindStdioProcessSignals(
  handle: StdioCloseTarget,
  options: StdioProcessSignalsOptions = {},
): StdioProcessSignalsBinding {
  if (bound.has(handle)) {
    throw new Error(
      '[stitchkit] bindStdioProcessSignals: this stdio handle is already bound; close the first binding before creating another',
    );
  }
  bound.add(handle);

  const signals = [...new Set(options.signals ?? DEFAULT_PROCESS_SIGNALS)];
  const source = options.signalSource ?? defaultSignalSource;
  const handlers: [ProcessSignalName, () => void][] = [];
  let started = false;
  let sameTurnAsStart = false;
  let closed = false;

  let resolveChain: () => void = () => undefined;
  let rejectChain: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveChain = resolve;
    rejectChain = reject;
  });
  void promise.catch(() => undefined);

  const removeListeners = (): void => {
    if (closed) return;
    closed = true;
    for (const [signal, handler] of handlers) source.off(signal, handler);
    if (!started) bound.delete(handle);
  };

  const close = (): void => {
    const hadStarted = started;
    removeListeners();
    if (!hadStarted) resolveChain();
  };

  const run = async (signal: ProcessSignalName): Promise<void> => {
    try {
      await options.onClose?.(signal);
    } catch (error) {
      reportSignalError('prepare', error, options.onError);
    }

    try {
      await handle.close();
    } catch (error) {
      rejectChain(error);
      reportSignalError('close', error, options.onError);
      removeListeners();
      return;
    }

    resolveChain();
    try {
      await options.onComplete?.();
    } catch (error) {
      reportSignalError('complete', error, options.onError);
    } finally {
      removeListeners();
    }
  };

  const onSignal = (signal: ProcessSignalName): void => {
    if (!started) {
      started = true;
      sameTurnAsStart = true;
      queueMicrotask(() => {
        sameTurnAsStart = false;
      });
      void run(signal).catch((error) => reportSignalError('close', error, options.onError));
      return;
    }
    if (sameTurnAsStart) return;

    removeListeners();
    guardSignalCallback(() => options.onRepeatedSignal?.(signal), 'close', options.onError);
    let restored = false;
    try {
      restored = source.raiseDefault(signal);
    } catch (error) {
      reportSignalError('close', error, options.onError);
    }
    if (!restored) {
      guardSignalCallback(
        () => options.onEscalationBlocked?.(signal),
        'close',
        options.onError,
      );
    }
  };

  for (const signal of signals) {
    const handler = () => onSignal(signal);
    handlers.push([signal, handler]);
    source.on(signal, handler);
  }

  return { promise, close };
}
