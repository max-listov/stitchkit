import { definePermissionMatrix } from 'stitchkit/primitives';

/**
 * The admin panel as data: what sections exist, where they live, who may do what
 * and whether a section still runs on fixture. `docs/ADMIN_MOCK.md` is this table
 * for a reader, and a section leaves it for real by turning `live`.
 */
export const adminPermissions = definePermissionMatrix({
  roles: ['owner', 'manager', 'viewer'],
  operations: ['records.read', 'records.write', 'people.read', 'people.write'],
  grants: {
    owner: {
      'records.read': true,
      'records.write': true,
      'people.read': true,
      'people.write': true,
    },
    manager: {
      'records.read': true,
      'records.write': true,
      'people.read': true,
      'people.write': false,
    },
    viewer: {
      'records.read': true,
      'records.write': false,
      'people.read': false,
      'people.write': false,
    },
  },
});

export type AdminRole = (typeof adminPermissions.definition.roles)[number];
export type AdminOperation = (typeof adminPermissions.definition.operations)[number];

export interface AdminSection {
  id: string;
  /** Under `/admin`; the first section is also the panel's own address. */
  path: string;
  label: string;
  read: AdminOperation;
  write: AdminOperation;
  /** `mock` reads `fixture/`; `live` reads the API. */
  status: 'mock' | 'live';
}

export const adminSections: readonly AdminSection[] = [
  {
    id: 'records',
    path: '/admin',
    label: 'Records',
    read: 'records.read',
    write: 'records.write',
    status: 'mock',
  },
  {
    id: 'people',
    path: '/admin/people',
    label: 'People',
    read: 'people.read',
    write: 'people.write',
    status: 'mock',
  },
];

export function sectionAt(segment: string | undefined): AdminSection | undefined {
  const path = segment === undefined ? '/admin' : `/admin/${segment}`;
  return adminSections.find((section) => section.path === path);
}

export function sectionsFor(role: AdminRole): readonly AdminSection[] {
  return adminSections.filter((section) => adminPermissions.allows(role, section.read));
}

/** By id: a section that crossed from a server component is a copy. */
export function canOpen(role: AdminRole, section: AdminSection): boolean {
  return sectionsFor(role).some(({ id }) => id === section.id);
}
