import { z } from 'zod';
import source from '../../../app.config.json' with { type: 'json' };

export const ApplicationIdentitySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.object({
    en: z.string().trim().min(1),
    ru: z.string().trim().min(1),
  }),
});

export const appIdentity = ApplicationIdentitySchema.parse(source);
