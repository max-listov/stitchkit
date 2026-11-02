import { notFound } from 'next/navigation';
import { sectionAt } from '@/features/admin/admin-sections';
import { AdminWorkspace } from '@/features/admin/admin-workspace';
import { adminFixture } from '@/features/admin/fixture/admin-fixture';

/**
 * `.dev.tsx` is a page extension of the development server only (`next.config.ts`),
 * so a production build has no such route and nothing here enters its graph.
 * `scripts/fixture-boundary.ts` proves that on the built files. Once a section
 * reads the API, name this file `page.tsx` and drop the fixture import.
 */
export default async function AdminPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section: segments = [] } = await params;
  const section = segments.length > 1 ? undefined : sectionAt(segments[0]);
  if (!section) notFound();
  return <AdminWorkspace section={section} data={adminFixture} />;
}
