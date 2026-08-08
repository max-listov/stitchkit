'use client';

import { IconCheck, IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { ClientThemeProvider } from '@wrksz/themes/client/provider';
import { ThemedImage } from '@wrksz/themes/client/themed-image';
import { useHydrated } from '@wrksz/themes/client/use-hydrated';
import { useTheme } from '@wrksz/themes/client/use-theme';
import { useThemeEffect } from '@wrksz/themes/client/use-theme-effect';
import { useThemeValue } from '@wrksz/themes/client/use-theme-value';
import { useCallback, useState } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { type AppTheme, appThemes } from '@/theme/config';
import {
  runThemeTransition,
  type ThemeTransitionConfig,
  type ThemeTransitionStyle,
} from '@/theme/transition';
import { StorySection } from './catalogue-shell';

type ThemeSelection = AppTheme | 'system';

const themeChoices = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
  { value: 'system', label: 'System', icon: IconDeviceDesktop },
] satisfies ReadonlyArray<{
  value: ThemeSelection;
  label: string;
  icon: typeof IconSun;
}>;

const themeImages = {
  light: '/theme-light.svg',
  dark: '/theme-dark.svg',
} satisfies Record<AppTheme, string>;

const transitionStyles = [
  { value: 'crossfade', label: 'Crossfade' },
  { value: 'radial', label: 'Radial reveal' },
] satisfies ReadonlyArray<{ value: ThemeTransitionStyle; label: string }>;

const transitionDurations = [150, 250, 400];

function ScopedThemeCard({ theme }: { theme: AppTheme }) {
  const { resolvedTheme } = useTheme<AppTheme>();

  return (
    <div
      id={`theme-scope-${theme}`}
      className='rounded-2xl border border-border bg-background p-5 text-foreground'
    >
      <div className='flex items-center justify-between gap-4'>
        <div>
          <p className='font-medium'>{theme === 'light' ? 'Forced light' : 'Forced dark'}</p>
          <p className='mt-1 text-sm text-muted-foreground'>Independent client provider</p>
        </div>
        <Badge variant='secondary'>{resolvedTheme ?? 'hydrating'}</Badge>
      </div>
    </div>
  );
}

export function ThemeStoryClient({ serverTheme }: { serverTheme: ThemeSelection }) {
  const hydrated = useHydrated();
  const { theme, resolvedTheme, systemTheme, setTheme } = useTheme<AppTheme>();
  const surfaceLabel = useThemeValue({
    light: 'Paper surface',
    dark: 'Midnight surface',
    default: 'Resolving surface',
  });
  const [lastChange, setLastChange] = useState('No client change yet');
  const [transitionStyle, setTransitionStyle] = useState<ThemeTransitionStyle>('crossfade');
  const [transitionDuration, setTransitionDuration] = useState(250);
  const transitionConfig = {
    style: transitionStyle,
    durationMs: transitionDuration,
    easing: 'ease-out',
  } satisfies ThemeTransitionConfig;
  const captureThemeChange = useCallback(
    (selected: string | undefined, resolved: string | undefined) => {
      setLastChange(`${selected ?? 'unknown'} → ${resolved ?? 'unknown'}`);
    },
    [],
  );
  useThemeEffect(captureThemeChange);

  const selectTheme = (selection: ThemeSelection, trigger: HTMLButtonElement) => {
    const bounds = trigger.getBoundingClientRect();
    runThemeTransition(() => setTheme(selection), transitionConfig, {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  };

  return (
    <div>
      <StorySection title='Native transition lab'>
        <div className='grid gap-5 rounded-2xl border border-border bg-card p-5 sm:grid-cols-2'>
          <div>
            <p className='text-sm font-medium'>Effect</p>
            <div className='mt-3 flex flex-wrap gap-2'>
              {transitionStyles.map((option) => (
                <Button
                  key={option.value}
                  size='sm'
                  variant={transitionStyle === option.value ? 'primary' : 'outline'}
                  aria-pressed={transitionStyle === option.value}
                  onClick={() => setTransitionStyle(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className='text-sm font-medium'>Duration</p>
            <div className='mt-3 flex flex-wrap gap-2'>
              {transitionDurations.map((duration) => (
                <Button
                  key={duration}
                  size='sm'
                  variant={transitionDuration === duration ? 'primary' : 'outline'}
                  aria-pressed={transitionDuration === duration}
                  onClick={() => setTransitionDuration(duration)}
                >
                  {duration} ms
                </Button>
              ))}
            </div>
          </div>
        </div>
        <p className='text-sm text-muted-foreground'>
          Theme state still belongs to @wrksz/themes. This page only configures the native
          snapshot animation used by the controls below.
        </p>
      </StorySection>

      <StorySection title='Global typed theme state'>
        <div className='grid gap-3 sm:grid-cols-3'>
          {themeChoices.map((choice) => (
            <Button
              key={choice.value}
              variant={theme === choice.value ? 'primary' : 'outline'}
              aria-pressed={theme === choice.value}
              onClick={(event) => selectTheme(choice.value, event.currentTarget)}
            >
              <choice.icon />
              {choice.label}
              {theme === choice.value ? <IconCheck aria-hidden /> : null}
            </Button>
          ))}
        </div>
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {[
            ['Selected', hydrated ? (theme ?? 'unknown') : 'hydrating'],
            ['Resolved', hydrated ? (resolvedTheme ?? 'unknown') : 'hydrating'],
            ['Operating system', hydrated ? (systemTheme ?? 'unknown') : 'hydrating'],
            ['Server cookie', serverTheme],
          ].map(([label, value]) => (
            <Card
              key={label}
              data-testid={`theme-state-${label.toLowerCase().replaceAll(' ', '-')}`}
            >
              <CardHeader>
                <CardTitle className='text-sm text-muted-foreground'>{label}</CardTitle>
              </CardHeader>
              <CardContent className='font-medium'>{value}</CardContent>
            </Card>
          ))}
        </div>
        <p className='text-sm text-muted-foreground'>
          {surfaceLabel} · Last observed change: {lastChange}
        </p>
      </StorySection>

      <StorySection title='Theme-aware media'>
        <ThemedImage
          src={themeImages}
          alt='Application shell selected by the resolved theme'
          width={1280}
          height={720}
          className='w-full rounded-2xl border border-border'
        />
      </StorySection>

      <StorySection title='Independent scoped themes'>
        <div className='grid gap-4 md:grid-cols-2'>
          <ClientThemeProvider<AppTheme>
            themes={appThemes}
            forcedTheme='light'
            target='#theme-scope-light'
            storage='none'
          >
            <ScopedThemeCard theme='light' />
          </ClientThemeProvider>
          <ClientThemeProvider<AppTheme>
            themes={appThemes}
            forcedTheme='dark'
            target='#theme-scope-dark'
            storage='none'
          >
            <ScopedThemeCard theme='dark' />
          </ClientThemeProvider>
        </div>
      </StorySection>
    </div>
  );
}
