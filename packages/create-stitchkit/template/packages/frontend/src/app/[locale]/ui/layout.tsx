import type { ReactNode } from 'react';
import { CatalogueShell } from './_catalogue';

export default function UiLayout({ children }: { children: ReactNode }) {
  return <CatalogueShell>{children}</CatalogueShell>;
}
