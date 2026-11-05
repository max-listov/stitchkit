import { type CliRenderer, type CliRendererConfig, createCliRenderer } from '@opentui/core';
import { createRoot, useTerminalDimensions } from '@opentui/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { type TerminalLabels, terminalLabelsEn } from '../core/labels';
import { sanitizeTerminalText, wrapTerminalText } from '../core/text';
import type { TerminalPalette, TerminalThemeMode } from '../core/theme';
import { TerminalLabelsProvider, useTerminalLabels } from './context';
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
 * stack, in place of the screen. It stands above OpenTUI's own root boundary,
 * which is compiled with React's development JSX and renders nothing under the
 * production build — so without this one a thrown screen is a blank terminal.
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

/** The signals that end a terminal application: Ctrl-C, a kill, and a closed window. */
export const TERMINAL_EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type TerminalExitSignal = (typeof TERMINAL_EXIT_SIGNALS)[number];

const SIGNAL_EXIT_CODE: Record<TerminalExitSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export interface RunTerminalAppOptions {
  /** `auto` asks the terminal for its background and waits at most `themeTimeoutMs`. */
  themeMode?: TerminalThemeMode | 'auto';
  themeTimeoutMs?: number;
  /** Colours to change in the chosen palette. */
  palette?: Partial<TerminalPalette>;
  labels?: TerminalLabels;
  /** Renderer options; `exitOnCtrlC` stays off: the signals below end the application. */
  renderer?: Omit<CliRendererConfig, 'exitOnCtrlC'>;
  /** Signals that close the application and then exit the process with 128 + the signal number. */
  exitSignals?: readonly TerminalExitSignal[];
  /** Release what the screens hold — sockets, timers, child processes — before the process exits. */
  onClose?: () => void | Promise<void>;
  /** The longest `onClose` may take on a signal before the process exits anyway. */
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

/**
 * Start a terminal application: the renderer, the React root, the theme and
 * labels providers and an error boundary that shows the cause on screen. A
 * closed window (SIGHUP), a kill (SIGTERM) or Ctrl-C (SIGINT) destroys the
 * renderer and exits the process, so no orphan keeps drawing frames.
 */
export async function runTerminalApp(
  screen: ReactNode | ((app: { close(): Promise<void> }) => ReactNode),
  options: RunTerminalAppOptions = {},
): Promise<RunningTerminalApp> {
  const renderer = await createCliRenderer({ ...options.renderer, exitOnCtrlC: false });
  const mode = options.themeMode ?? 'auto';
  // The first frame is drawn in the terminal's own background when it answers in time;
  // the provider keeps following it afterwards.
  if (mode === 'auto') await renderer.waitForThemeMode(options.themeTimeoutMs ?? 250);
  const root = createRoot(renderer);
  const signals = options.exitSignals ?? TERMINAL_EXIT_SIGNALS;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;
  const listeners = new Map<TerminalExitSignal, () => void>();
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
      try {
        root.unmount();
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
  for (const signal of signals) {
    const listener = (): void => {
      const exit = (): never => process.exit(SIGNAL_EXIT_CODE[signal]);
      // A hung `onClose` must not keep a window-less process alive.
      setTimeout(exit, options.closeTimeoutMs ?? 1000).unref();
      close().then(exit, exit);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  const app = { close };
  const content = typeof screen === 'function' ? screen(app) : screen;
  root.render(
    <TerminalThemeProvider mode={mode} {...(options.palette && { palette: options.palette })}>
      <TerminalLabelsProvider labels={options.labels ?? terminalLabelsEn}>
        <TerminalErrorBoundary onError={options.onError}>{content}</TerminalErrorBoundary>
      </TerminalLabelsProvider>
    </TerminalThemeProvider>,
  );
  return { renderer, close, closed };
}
