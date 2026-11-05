import { constants } from 'node:os';
import { type CliRenderer, type CliRendererConfig, createCliRenderer } from '@opentui/core';
import { createRoot, type Root, useTerminalDimensions } from '@opentui/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { type TerminalLabels, terminalLabelsEn } from '../core/labels';
import { sanitizeTerminalText, wrapTerminalText } from '../core/text';
import type { TerminalPalette, TerminalThemeMode } from '../core/theme';
import { TerminalLabelsProvider, useTerminalLabels } from './context';
import { TerminalKeyPriority, useTerminalKeyboard } from './keyboard';
import { TerminalThemeProvider, useTerminalPalette } from './theme';

function TerminalErrorScreen({ error }: { error: unknown }) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const dimensions = useTerminalDimensions();
  const width = Math.max(20, dimensions.width - 4);
  const detail =
    error instanceof Error
      ? [`${error.name}: ${error.message}`, ...(error.stack?.split('\n').slice(1, 9) ?? [])]
      : [String(error)];
  // The cause first; the stack only as far as the screen has rows for it.
  const lines = detail
    .flatMap((line) => wrapTerminalText(sanitizeTerminalText(line), width))
    .slice(0, Math.max(1, dimensions.height - 4));
  return (
    <box style={{ flexDirection: 'column', padding: 1, backgroundColor: palette.canvas }}>
      <text fg={palette.danger} style={{ flexShrink: 0 }}>
        {labels.crashed}
      </text>
      {lines.map((line, index) => (
        <text
          key={index}
          fg={index === 0 ? palette.primary : palette.muted}
          wrapMode='none'
          style={{ flexShrink: 0 }}
        >
          {line}
        </text>
      ))}
    </box>
  );
}

interface BoundaryProps {
  children: ReactNode;
  onError?: ((error: unknown, info: ErrorInfo) => void) | undefined;
}

/**
 * Catches an error a screen throws while rendering and draws it, with its
 * stack, in place of the screen. It is the nearest boundary to the screens,
 * inside OpenTUI's root one, which is compiled with React's development JSX and
 * renders nothing under the production build — so without this one a thrown
 * screen is a blank terminal.
 */
export class TerminalErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('Unknown render error') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <TerminalErrorScreen error={this.state.error} />
    );
  }
}

/**
 * Every signal OpenTUI listens for to restore the terminal. Its listener cancels
 * the signal's default exit, so each one must end the application here, or a
 * window-less process keeps running: a closed window (SIGHUP), a kill (SIGTERM),
 * SIGINT, SIGQUIT, SIGABRT, a broken pipe and a bus error. SIGBREAK is Windows'.
 */
export const TERMINAL_EXIT_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
  'SIGABRT',
  'SIGPIPE',
  'SIGBUS',
  'SIGBREAK',
] as const;
export type TerminalExitSignal = (typeof TERMINAL_EXIT_SIGNALS)[number];

function exitCode(signal: TerminalExitSignal): number {
  return 128 + (constants.signals[signal] ?? 0);
}

export interface RunTerminalAppOptions {
  /** `auto` asks the terminal for its background and waits at most `themeTimeoutMs`. */
  themeMode?: TerminalThemeMode | 'auto';
  themeTimeoutMs?: number;
  /** Colours to change in the chosen palette. */
  palette?: Partial<TerminalPalette>;
  labels?: TerminalLabels;
  /** Renderer options; the application, not the renderer, owns exits and their signals. */
  renderer?: Omit<CliRendererConfig, 'exitOnCtrlC' | 'exitSignals'>;
  /** Signals that close the application and then exit the process with 128 + the signal number. */
  exitSignals?: readonly TerminalExitSignal[];
  /**
   * Ctrl-C arrives as a key in raw mode, not as SIGINT: one no screen took closes the
   * application and exits with 130, like SIGINT. On by default.
   */
  exitOnCtrlC?: boolean;
  /** Release what the screens hold — sockets, timers, child processes — before the process exits. */
  onClose?: () => void | Promise<void>;
  /** The longest `onClose` may take on a signal or Ctrl-C before the process exits anyway. */
  closeTimeoutMs?: number;
  onError?: (error: unknown, info: ErrorInfo) => void;
}

export interface RunningTerminalApp {
  renderer: CliRenderer;
  /** Unmount, restore the terminal and run `onClose`; the process keeps running. */
  close(): Promise<void>;
  /** Settles once the application closed, however it closed. */
  closed: Promise<void>;
}

/** Below every screen handler: Ctrl-C reaches it only when nothing else took the key. */
function CtrlCExit({ onExit }: { onExit(): void }) {
  useTerminalKeyboard(
    (key) => {
      if (!key.ctrl || key.name !== 'c') return false;
      onExit();
      return true;
    },
    { priority: TerminalKeyPriority.global - 1 },
  );
  return null;
}

type ScreenFactory = (app: { close(): Promise<void> }) => ReactNode;

/** A screen given as a function renders as a component, so what it throws reaches the boundary. */
function FactoryScreen({
  factory,
  app,
}: {
  factory: ScreenFactory;
  app: { close(): Promise<void> };
}) {
  return <>{factory(app)}</>;
}

/**
 * Start a terminal application: the renderer, the React root, the theme and
 * labels providers and an error boundary that shows the cause on screen. A
 * closed window (SIGHUP), a kill, Ctrl-C and the other signals OpenTUI catches
 * destroy the renderer, run `onClose` and exit the process, so no orphan keeps
 * drawing frames.
 */
export async function runTerminalApp(
  screen: ReactNode | ScreenFactory,
  options: RunTerminalAppOptions = {},
): Promise<RunningTerminalApp> {
  // OpenTUI's own signal listeners only destroy the renderer; the application owns exits.
  const renderer = await createCliRenderer({
    ...options.renderer,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const signals = (options.exitSignals ?? TERMINAL_EXIT_SIGNALS).filter(
    (signal) => signal !== 'SIGBREAK' || process.platform === 'win32',
  );
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let root: Root | undefined;
  let closing: Promise<void> | undefined;
  const listeners = new Map<TerminalExitSignal, () => void>();
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
      try {
        root?.unmount();
      } finally {
        renderer.destroy();
        try {
          await options.onClose?.();
        } finally {
          resolveClosed();
        }
      }
    })();
    return closing;
  };
  const exitWith = (code: number): void => {
    const exit = (): never => process.exit(code);
    // A hung `onClose` must not keep a window-less process alive.
    setTimeout(exit, options.closeTimeoutMs ?? 1000).unref();
    close().then(exit, (error: unknown) => {
      console.error('runTerminalApp: onClose failed while exiting', error);
      exit();
    });
  };
  // Listen before anything else can wait: a window closed during start-up still exits.
  for (const signal of signals) {
    const listener = (): void => exitWith(exitCode(signal));
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  try {
    const mode = options.themeMode ?? 'auto';
    // The first frame is drawn in the terminal's own background when it answers in time;
    // the provider keeps following it afterwards.
    if (mode === 'auto') await renderer.waitForThemeMode(options.themeTimeoutMs ?? 250);
    if (closing) return { renderer, close, closed };
    root = createRoot(renderer);
    const app = { close };
    root.render(
      <TerminalThemeProvider
        mode={mode}
        {...(options.palette && { palette: options.palette })}
      >
        <TerminalLabelsProvider labels={options.labels ?? terminalLabelsEn}>
          {options.exitOnCtrlC === false ? null : <CtrlCExit onExit={() => exitWith(130)} />}
          <TerminalErrorBoundary onError={options.onError}>
            {typeof screen === 'function' ? (
              <FactoryScreen factory={screen} app={app} />
            ) : (
              screen
            )}
          </TerminalErrorBoundary>
        </TerminalLabelsProvider>
      </TerminalThemeProvider>,
    );
  } catch (error) {
    await close();
    throw error;
  }
  return { renderer, close, closed };
}
