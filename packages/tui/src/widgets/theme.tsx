import { useRenderer } from '@opentui/react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  resolveTerminalPalette,
  type TerminalPalette,
  type TerminalThemeMode,
  terminalPalettes,
} from '../core/theme';

const PaletteContext = createContext<TerminalPalette>(terminalPalettes.dark);

/** The palette widgets draw with: the nearest provider's, or the dark one. */
export function useTerminalPalette(): TerminalPalette {
  return useContext(PaletteContext);
}

/**
 * Follow the terminal's background: `auto` reads what the terminal reports
 * (OSC colour query) and switches when it changes; until it answers, and on a
 * terminal that never does, the palette is dark.
 */
export function useTerminalThemeMode(mode: TerminalThemeMode | 'auto'): TerminalThemeMode {
  const renderer = useRenderer();
  const [reported, setReported] = useState<TerminalThemeMode | null>(renderer.themeMode);
  useEffect(() => {
    if (mode !== 'auto') return;
    const update = (next: TerminalThemeMode): void => setReported(next);
    renderer.on('theme_mode', update);
    setReported(renderer.themeMode);
    return () => {
      renderer.off('theme_mode', update);
    };
  }, [mode, renderer]);
  return mode === 'auto' ? (reported ?? 'dark') : mode;
}

export function TerminalThemeProvider({
  mode = 'auto',
  palette,
  children,
}: {
  mode?: TerminalThemeMode | 'auto';
  /** Colours to change in the chosen palette. */
  palette?: Partial<TerminalPalette>;
  children: ReactNode;
}) {
  const resolved = useTerminalThemeMode(mode);
  const value = useMemo(() => resolveTerminalPalette(resolved, palette), [resolved, palette]);
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}
