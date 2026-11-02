import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  adminPermissions,
  adminSections,
  canOpen,
  sectionAt,
  sectionsFor,
} from './admin-sections';
import { AdminSectionView } from './admin-workspace';
import { adminFixture } from './fixture/admin-fixture';

function rendered(sectionId: string, role: 'owner' | 'manager' | 'viewer'): string {
  const section = adminSections.find(({ id }) => id === sectionId);
  if (!section) throw new Error(`no section ${sectionId}`);
  return renderToStaticMarkup(
    <AdminSectionView section={section} rows={adminFixture[section.id] ?? []} role={role} />,
  );
}

describe('the admin panel on fixture', () => {
  test('a section renders its rows from the fixture alone, with no database', () => {
    const page = rendered('records', 'owner');
    expect(page).toContain('First record');
    expect(page).toContain('Fixture');
    expect(page).toContain('Edit');
  });

  test('a role without the write operation has no action', () => {
    expect(rendered('records', 'viewer')).not.toContain('Edit');
    expect(rendered('people', 'manager')).not.toContain('Edit');
  });

  test('a role sees only the sections it may read', () => {
    expect(sectionsFor('viewer').map(({ id }) => id)).toEqual(['records']);
    expect(sectionsFor('owner').map(({ id }) => id)).toEqual(['records', 'people']);
  });

  test('a section that crossed from the server opens like the original', () => {
    const copy = structuredClone(sectionAt('people'));
    if (!copy) throw new Error('no people section');
    expect(canOpen('owner', copy)).toBe(true);
    expect(canOpen('viewer', copy)).toBe(false);
  });

  test('every section has its fixture, and every operation it names exists', () => {
    for (const section of adminSections) {
      expect(adminFixture[section.id]?.length).toBeGreaterThan(0);
      expect(adminPermissions.check('owner', section.read).outcome).toBe('allowed');
      expect(adminPermissions.check('owner', section.write).outcome).toBe('allowed');
    }
  });

  test('an address resolves to one section or to none', () => {
    expect(sectionAt(undefined)?.id).toBe('records');
    expect(sectionAt('people')?.id).toBe('people');
    expect(sectionAt('missing')).toBeUndefined();
  });
});
