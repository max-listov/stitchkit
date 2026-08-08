import { z } from 'zod';

export const LocaleSchema = z.enum(['en', 'ru']);
export type AppLocale = z.infer<typeof LocaleSchema>;
export const locales = LocaleSchema.options;
export const defaultLocale: AppLocale = 'en';
