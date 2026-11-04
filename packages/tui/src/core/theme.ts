import { z } from 'zod';

/**
 * What a colour means, not what it is. Every widget and the agent shell speak
 * this one vocabulary; the palette decides the colour per terminal background.
 */
export const TerminalToneSchema = z.enum([
  'primary',
  'muted',
  'accent',
  'success',
  'warning',
  'danger',
]);

export type TerminalTone = z.infer<typeof TerminalToneSchema>;

export const TerminalThemeModeSchema = z.enum(['dark', 'light']);

export type TerminalThemeMode = z.infer<typeof TerminalThemeModeSchema>;

/** A colour the renderer understands: `#rgb`, `#rrggbb`, `#rrggbbaa` or a CSS name. */
const ColorSchema = z.string().min(1);

export const TerminalPaletteSchema = z
  .object({
    canvas: ColorSchema,
    panel: ColorSchema,
    panelRaised: ColorSchema,
    border: ColorSchema,
    borderActive: ColorSchema,
    primary: ColorSchema,
    muted: ColorSchema,
    accent: ColorSchema,
    success: ColorSchema,
    warning: ColorSchema,
    danger: ColorSchema,
  })
  .strict();

/** Surfaces plus one colour per {@link TerminalTone}. */
export type TerminalPalette = z.infer<typeof TerminalPaletteSchema>;

export const terminalPalettes: Readonly<Record<TerminalThemeMode, TerminalPalette>> =
  Object.freeze({
    dark: Object.freeze({
      canvas: '#111111',
      panel: '#1e2129',
      panelRaised: '#303441',
      border: '#454a57',
      borderActive: '#d9dde7',
      primary: '#e6ebf5',
      muted: '#828aa0',
      accent: '#e58a66',
      success: '#64df98',
      warning: '#ffd04f',
      danger: '#ff6b78',
    }),
    light: Object.freeze({
      canvas: '#fafafa',
      panel: '#eef0f4',
      panelRaised: '#dfe3ea',
      border: '#b4bac6',
      borderActive: '#2b303b',
      primary: '#1d2129',
      muted: '#646b7a',
      accent: '#b5502b',
      success: '#1a7f45',
      warning: '#946200',
      danger: '#c4283a',
    }),
  });

/** The palette for a terminal background, with any colours the product overrides. */
export function resolveTerminalPalette(
  mode: TerminalThemeMode,
  overrides: Partial<TerminalPalette> = {},
): TerminalPalette {
  return TerminalPaletteSchema.parse({
    ...terminalPalettes[TerminalThemeModeSchema.parse(mode)],
    ...overrides,
  });
}
