'use client';

import { useEffect, useState } from 'react';

/**
 * Определяет touch устройство
 *
 * Проверяет:
 * - ontouchstart в window
 * - navigator.maxTouchPoints
 * - media query (pointer: coarse)
 */
export function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    setIsTouch(
      'ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        window.matchMedia('(pointer: coarse)').matches,
    );
  }, []);

  return isTouch;
}
