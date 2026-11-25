/**
 * Refuse the removed `transports` declaration key loudly instead of letting a
 * spread or JS caller silently fall back to the default MCP + AGENT surface.
 */
export function assertNoLegacyTransports(config: object, subject: string): void {
  if (Object.hasOwn(config, 'transports')) {
    throw new TypeError(`${subject}: "transports" was renamed to "expose"`);
  }
}
