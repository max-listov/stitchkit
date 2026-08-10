import { basename } from 'node:path';
import { z } from 'zod';

export const ApplicationSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens (for example: talk-control)',
  );

export const ApplicationIdentitySchema = z.object({
  slug: ApplicationSlugSchema,
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use a semantic version such as 0.1.0'),
  description: z.object({
    en: z.string().trim().min(1),
    ru: z.string().trim().min(1),
  }),
});

export type ApplicationIdentity = z.infer<typeof ApplicationIdentitySchema>;

function displayNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function createApplicationIdentity(
  destination: string,
  displayName?: string,
): ApplicationIdentity {
  const slug = ApplicationSlugSchema.parse(basename(destination));
  const name = displayName?.trim() || displayNameFromSlug(slug);
  return ApplicationIdentitySchema.parse({
    slug,
    name,
    version: '0.1.0',
    description: {
      en: `${name} is a production application built with Stitchkit.`,
      ru: `${name} — production-приложение на Stitchkit.`,
    },
  });
}
