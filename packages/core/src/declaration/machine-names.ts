/**
 * The hygiene every free string of a declaration goes through: a value that can
 * only be true of a particular machine is refused, because the deployment
 * supplies it, not the code.
 */
import type { z } from 'zod';

/**
 * Does this string name a particular machine?
 *
 * Every pattern here is something that cannot be true of code alone. Kept in
 * one place because the previous version of this schema checked only `://`, in
 * only one of the four fields a human writes freely — and a connection string
 * with credentials, a secret and an absolute path all passed.
 */
const MACHINE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/:\/\//, 'an absolute address'],
  [/^\/\//, 'a protocol-relative host'],
  [/^[~]/, 'a home-relative path'],
  [/^[A-Za-z]:[\\/]/, 'a Windows drive path'],
  [/\\/, 'a Windows path separator'],
  [/(?:^|[\s=:])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/, 'an IP address'],
  [/(?:^|[\s=])[A-Za-z][\w.-]*:\d{2,5}(?![\w.])/, 'a host and port'],
];

/** The reason this string names a machine, or `undefined` when it does not. */
export function namesAMachine(value: string): string | undefined {
  for (const [pattern, reason] of MACHINE_PATTERNS) {
    if (pattern.test(value)) return reason;
  }
  return undefined;
}

/** A string schema that refuses a value naming a machine, the message led by `label`. */
export function refuseMachineNames(label: string) {
  return (schema: z.ZodString) =>
    schema.refine((value) => namesAMachine(value) === undefined, {
      error: (issue) =>
        `${label} names a machine — ${namesAMachine(String(issue.input)) ?? 'a value of the deployment'} is supplied by the deployment, not written in the code`,
    });
}
