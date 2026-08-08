import type { ThemeProviderProps } from '@wrksz/themes/next';

export type AppTheme = 'light' | 'dark';

export const appThemes: readonly [AppTheme, AppTheme] = ['light', 'dark'];
export const themeStorageKey = 'stitchkit-starter-theme';

export const themeProviderConfig = {
  themes: appThemes,
  attribute: 'class',
  defaultTheme: 'system',
  enableSystem: true,
  enableColorScheme: true,
  storage: 'hybrid',
  storageKey: themeStorageKey,
  themeColor: {
    light: '#ffffff',
    dark: '#242428',
  },
} satisfies Omit<ThemeProviderProps<AppTheme>, 'children'>;
