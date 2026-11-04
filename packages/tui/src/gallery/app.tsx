import { useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import {
  defineTerminalKeymap,
  matchTerminalKey,
  type TerminalKeyBinding,
} from '../core/key-hints';
import { terminalLabelsEn, terminalLabelsRu } from '../core/labels';
import {
  createTerminalNotices,
  nextTerminalNoticeExpiry,
  reduceTerminalNotices,
} from '../core/notices';
import { createTerminalTabs, reduceTerminalTabs } from '../core/tabs';
import type { TerminalThemeMode } from '../core/theme';
import { TerminalLabelsProvider } from '../widgets/context';
import { TerminalKeyPriority, useTerminalKeyboard } from '../widgets/keyboard';
import { TerminalAppShell } from '../widgets/layout';
import { TerminalTabs } from '../widgets/tabs';
import { TerminalThemeProvider, useTerminalThemeMode } from '../widgets/theme';
import { CatalogueDemo } from './catalogue';
import { MonitorDemo } from './monitor-page';
import { WidgetsDemo } from './widgets-page';

const PAGES = [
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'widgets', label: 'Widgets' },
];

const globalKeymap = defineTerminalKeymap([
  { id: 'page-1', keys: ['f1'], display: 'F1–F3', label: 'pages', priority: 2 },
  { id: 'page-2', keys: ['f2'], display: 'F2', label: 'pages', hidden: true },
  { id: 'page-3', keys: ['f3'], display: 'F3', label: 'pages', hidden: true },
  { id: 'theme', keys: ['t'], ctrl: true, display: '^T', label: 'theme', priority: 3 },
  { id: 'language', keys: ['l'], ctrl: true, display: '^L', label: 'language', priority: 3 },
  { id: 'quit', keys: ['c'], ctrl: true, display: '^C', label: 'quit', priority: 1 },
]);

export interface TerminalGalleryProps {
  /** The clock every animated widget reads; tests pass a fixed one. */
  clock?: () => number;
  onExit?(): void;
}

/**
 * Every widget of the kit, live: a method catalogue (sections, search, form,
 * confirmation, spinner, JSON result, toasts), a process monitor and the small
 * widgets. Ctrl+T cycles auto/dark/light, Ctrl+L switches English/Russian.
 */
export function TerminalGallery({ clock = Date.now, onExit }: TerminalGalleryProps) {
  const [mode, setMode] = useState<TerminalThemeMode | 'auto'>('auto');
  const resolved = useTerminalThemeMode(mode);
  const [language, setLanguage] = useState<'en' | 'ru'>('en');
  return (
    <TerminalThemeProvider mode={resolved}>
      <TerminalLabelsProvider labels={language === 'ru' ? terminalLabelsRu : terminalLabelsEn}>
        <GalleryScreen
          clock={clock}
          {...(onExit && { onExit })}
          status={`theme ${mode}${mode === 'auto' ? ` (${resolved})` : ''} · ${language}`}
          onTheme={() =>
            setMode((current) =>
              current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto',
            )
          }
          onLanguage={() => setLanguage((current) => (current === 'en' ? 'ru' : 'en'))}
        />
      </TerminalLabelsProvider>
    </TerminalThemeProvider>
  );
}

function GalleryScreen({
  clock,
  onExit,
  status,
  onTheme,
  onLanguage,
}: {
  clock: () => number;
  onExit?(): void;
  status: string;
  onTheme(): void;
  onLanguage(): void;
}) {
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();
  const [startedAt] = useState(clock);
  const [tabs, tabsDispatch] = useReducer(reduceTerminalTabs, undefined, () =>
    createTerminalTabs(PAGES),
  );
  const [notices, noticesDispatch] = useReducer(reduceTerminalNotices, undefined, () =>
    createTerminalNotices(),
  );
  const [screen, setScreen] = useState<{ crumbs: string[]; bindings: TerminalKeyBinding[] }>({
    crumbs: [],
    bindings: [],
  });
  const onScreen = useCallback(
    (crumbs: string[], bindings: TerminalKeyBinding[]) => setScreen({ crumbs, bindings }),
    [],
  );
  const onNotice = useCallback(
    (text: string, tone: 'success' | 'danger' | 'warning') =>
      noticesDispatch({
        type: 'push',
        notice: { id: crypto.randomUUID(), text, tone, at: clock() },
      }),
    [clock],
  );
  useEffect(() => {
    const expiry = nextTerminalNoticeExpiry(notices);
    if (expiry === null) return;
    const timer = setTimeout(
      () => noticesDispatch({ type: 'expire', now: clock() }),
      Math.max(0, expiry - clock()),
    );
    return () => clearTimeout(timer);
  }, [notices, clock]);

  useTerminalKeyboard(
    (key) => {
      const id = matchTerminalKey(globalKeymap, key)?.id;
      if (id === undefined) return false;
      if (id === 'quit') {
        if (onExit) onExit();
        else renderer.destroy();
      } else if (id === 'theme') onTheme();
      else if (id === 'language') onLanguage();
      else tabsDispatch({ type: 'select-index', index: Number(id.slice(-1)) - 1 });
      return true;
    },
    { priority: TerminalKeyPriority.global },
  );

  const page = tabs.selectedId;
  const body = Math.max(6, height - 6);
  const bindings = page === 'catalogue' ? [...screen.bindings, ...globalKeymap] : globalKeymap;
  return (
    <TerminalAppShell
      breadcrumbs={[
        'stitchkit-tui',
        ...(page === 'catalogue'
          ? screen.crumbs
          : [PAGES.find(({ id }) => id === page)?.label ?? page]),
      ]}
      status={[
        [
          { text: status, tone: 'muted' },
          { text: `${width}×${height}`, tone: 'muted' },
        ],
      ]}
      bindings={bindings}
      notices={notices}
      width={width}
      height={height}
    >
      <TerminalTabs state={tabs} onAction={tabsDispatch} focused={false} />
      {page === 'catalogue' ? (
        <CatalogueDemo
          width={width}
          height={body}
          active
          clock={clock}
          onScreen={onScreen}
          onNotice={onNotice}
        />
      ) : page === 'monitor' ? (
        <MonitorDemo width={width} height={body} active clock={clock} />
      ) : (
        <WidgetsDemo width={width} clock={clock} startedAt={startedAt} />
      )}
    </TerminalAppShell>
  );
}
