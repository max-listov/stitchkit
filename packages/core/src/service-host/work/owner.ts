import { z } from 'zod';

/** A printable line: no control characters, so a label is safe in a unit description and a log. */
const PRINTABLE = /^\P{Cc}+$/u;

/** A launcher's own name: lowercase words joined by single hyphens. */
export const WorkLauncherSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * The launcher's id of one piece of work, unique among its live work on one machine. Only
 * characters systemd takes in a unit name unescaped, so the id reads the same in the unit name.
 */
export const WorkIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

/** A pointer to one owner record: which launcher, which of its work. */
export const WorkRefSchema = z.strictObject({
  launcher: WorkLauncherSchema,
  id: WorkIdSchema,
});
/** A pointer to one owner record. */
export type WorkRef = z.infer<typeof WorkRefSchema>;

/** The agent that asked for the work: its harness, its model and the address it answers at. */
export const WorkAgentSchema = z.strictObject({
  harness: z.string().trim().min(1).max(64).regex(PRINTABLE),
  model: z.string().trim().min(1).max(64).regex(PRINTABLE),
  address: z.string().trim().min(1).max(128).regex(PRINTABLE),
});
/** The agent that asked for the work. */
export type WorkAgent = z.infer<typeof WorkAgentSchema>;

/**
 * Who launched a piece of work. Every field is answered: `null` is a declared "none", a missing
 * field is refused.
 */
export const WorkOwnerSchema = z.strictObject({
  launcher: WorkLauncherSchema,
  id: WorkIdSchema,
  label: z.string().trim().min(1).max(120).regex(PRINTABLE),
  project: z.string().min(1).max(128).regex(/^\S+$/).nullable(),
  agent: WorkAgentSchema.nullable(),
  parent: WorkRefSchema.nullable(),
});
/** Who launched a piece of work. */
export type WorkOwner = z.infer<typeof WorkOwnerSchema>;
