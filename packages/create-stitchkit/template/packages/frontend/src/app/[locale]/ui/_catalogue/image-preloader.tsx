'use client';

import { preload } from 'react-dom';

export function ImagePreloader({ sources }: { sources: string[] }) {
  for (const source of sources) preload(source, { as: 'image' });
  return null;
}
