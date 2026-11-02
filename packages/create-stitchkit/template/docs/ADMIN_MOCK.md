# The admin panel on fixture

`/en/admin` shows the shape of a future admin panel before any of its API exists: sections, roles, tables
and dialogs, on invented rows and with no database. A customer sees the system and answers questions
about it before the first migration.

It exists in development only. Its route is `app/[locale]/admin/[[...section]]/page.dev.tsx`, and `.dev.tsx`
is a page extension of the development server alone (`next.config.ts`), so a production build has no such
route: the address answers 404 and the rows are not in the artifact.
`bun run acceptance:local` proves that on the built files (`scripts/fixture-boundary.ts`).

## Addresses

| Address | Section | Read | Write | Status |
|---|---|---|---|---|
| `/admin` | Records | `records.read` | `records.write` | `mock` |
| `/admin/people` | People | `people.read` | `people.write` | `mock` |

`features/admin/admin-sections.ts` is the source of this table. Keep them in step.

## Changing it

Rename the sections and the columns of `AdminRow` to your domain, in `admin-sections.ts`, `admin-data.ts`
and `fixture/admin-fixture.ts`. `adminPermissions` must decide every role against every operation, and the
role buttons in the sidebar switch between them for a demonstration only: they prove nothing to a server.

## Taking a section off fixture

1. Build the vertical slice by [`ADDING_A_FEATURE.md`](ADDING_A_FEATURE.md), answering `AdminRow`.
2. Enforce the same operation on the server, with `adminPermissions` moved to `packages/shared` so both sides
   read one matrix.
3. Set the section's `status` to `live`, supply its rows from the API, and rename the route to `page.tsx`, which
   production builds. Keep a section that is still `mock` behind a page of its own in `page.dev.tsx`.
4. Delete its rows from the fixture.

When no section is `mock`, delete `features/admin/fixture/`, `scripts/fixture-boundary.ts` and its acceptance
step. If the panel is not wanted at all, delete `features/admin` and
`app/[locale]/admin` as two directories, with the same script and step.
