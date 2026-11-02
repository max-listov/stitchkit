/**
 * What the panel renders, with nothing about where it comes from. A section's
 * fixture and its API answer have this one shape, so moving a section to the API
 * changes what supplies the rows and no component.
 */
export interface AdminRow {
  id: string;
  title: string;
  owner: string;
  state: 'active' | 'paused';
}

export type AdminData = Readonly<Record<string, readonly AdminRow[]>>;
