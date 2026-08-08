'use client';

import { useEffect, useState } from 'react';

/**
 * Хук для отслеживания media query
 *
 * @param query - CSS media query строка (например '(min-width: 768px)')
 * @returns true если query совпадает, false если нет или SSR
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mediaQuery = window.matchMedia(query);
    setMatches(mediaQuery.matches);

    const handler = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [query]);

  // Return false during SSR to avoid hydration mismatch
  return mounted ? matches : false;
}
