import type { AdminData } from '../admin-data';

/**
 * Invented rows, for showing the panel before its API exists. This directory is
 * reached only from the development-only `page.dev.tsx`. Their ids are what
 * `scripts/fixture-boundary.ts` looks for in a production build: keep the prefix
 * on rows you add, or that check has nothing to find.
 */
export const adminFixture: AdminData = {
  records: [
    {
      id: 'stitchkit-admin-fixture-r-1',
      title: 'First record',
      owner: 'Anna',
      state: 'active',
    },
    {
      id: 'stitchkit-admin-fixture-r-2',
      title: 'Second record',
      owner: 'Boris',
      state: 'active',
    },
    {
      id: 'stitchkit-admin-fixture-r-3',
      title: 'Third record',
      owner: 'Anna',
      state: 'paused',
    },
  ],
  people: [
    { id: 'stitchkit-admin-fixture-p-1', title: 'Anna', owner: 'owner', state: 'active' },
    { id: 'stitchkit-admin-fixture-p-2', title: 'Boris', owner: 'manager', state: 'active' },
    { id: 'stitchkit-admin-fixture-p-3', title: 'Vera', owner: 'viewer', state: 'paused' },
  ],
};
