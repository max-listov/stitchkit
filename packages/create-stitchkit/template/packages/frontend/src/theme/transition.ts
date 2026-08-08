export type ThemeTransitionStyle = 'crossfade' | 'radial';

export interface ThemeTransitionConfig {
  style: ThemeTransitionStyle;
  durationMs: number;
  easing: string;
}

export interface ThemeTransitionOrigin {
  x: number;
  y: number;
}

export const defaultThemeTransition = {
  style: 'crossfade',
  durationMs: 250,
  easing: 'ease-out',
} satisfies ThemeTransitionConfig;

export function runThemeTransition(
  updateTheme: () => void,
  config: ThemeTransitionConfig = defaultThemeTransition,
  origin?: ThemeTransitionOrigin,
) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reducedMotion) {
    updateTheme();
    return;
  }

  const root = document.documentElement;
  const transitionOrigin = origin ?? {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };
  root.classList.add('theme-transitioning');
  root.dataset.themeTransition = config.style;
  root.style.setProperty('--theme-transition-duration', `${config.durationMs}ms`);
  root.style.setProperty('--theme-transition-easing', config.easing);
  root.style.setProperty('--theme-transition-x', `${transitionOrigin.x}px`);
  root.style.setProperty('--theme-transition-y', `${transitionOrigin.y}px`);

  const cleanup = () => {
    root.classList.remove('theme-transitioning');
    delete root.dataset.themeTransition;
    root.style.removeProperty('--theme-transition-duration');
    root.style.removeProperty('--theme-transition-easing');
    root.style.removeProperty('--theme-transition-x');
    root.style.removeProperty('--theme-transition-y');
  };

  const transition = document.startViewTransition(updateTheme);
  transition.finished.then(cleanup, cleanup);
}
