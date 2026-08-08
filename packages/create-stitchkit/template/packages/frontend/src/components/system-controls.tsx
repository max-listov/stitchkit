'use client';

import {
  IconCheck,
  IconDeviceDesktop,
  IconLanguage,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';
import { useHydrated } from '@wrksz/themes/client/use-hydrated';
import { useTheme } from '@wrksz/themes/client/use-theme';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui';
import { Link, usePathname } from '@/i18n/navigation';
import type { AppTheme } from '@/theme/config';
import { defaultThemeTransition, runThemeTransition } from '@/theme/transition';

const themeOptions = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
  { value: 'system', label: 'System', icon: IconDeviceDesktop },
] satisfies ReadonlyArray<{
  value: AppTheme | 'system';
  label: string;
  icon: typeof IconSun;
}>;

export function ThemeToggle() {
  const hydrated = useHydrated();
  const { theme, resolvedTheme, setTheme } = useTheme<AppTheme>();
  const selectedTheme = hydrated ? theme : undefined;
  const ActiveIcon = resolvedTheme === 'dark' ? IconMoon : IconSun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size='icon'
          variant='outline'
          aria-label={`Theme: ${selectedTheme ?? 'loading'}`}
        >
          {hydrated ? <ActiveIcon /> : <IconDeviceDesktop />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {themeOptions.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() =>
              runThemeTransition(() => setTheme(option.value), defaultThemeTransition)
            }
          >
            <option.icon />
            <span className='flex-1'>{option.label}</span>
            {selectedTheme === option.value ? <IconCheck aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LanguageSwitcher() {
  const pathname = usePathname();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size='icon' variant='outline' aria-label='Change language'>
          <IconLanguage />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem asChild>
          <Link href={pathname} locale='en'>
            English
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={pathname} locale='ru'>
            Русский
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
