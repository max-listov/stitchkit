import { getTheme } from '@wrksz/themes/next';
import { appThemes, themeStorageKey } from '@/theme/config';
import { ThemeStoryClient } from './theme-story-client';

export async function ThemeStory() {
  const serverTheme = await getTheme({
    themes: appThemes,
    defaultTheme: 'system',
    storageKey: themeStorageKey,
  });

  return <ThemeStoryClient serverTheme={serverTheme} />;
}
