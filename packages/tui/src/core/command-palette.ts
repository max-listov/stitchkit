import { z } from 'zod';

export const TerminalCommandDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    aliases: z.array(z.string().min(1)).default([]),
    label: z.string().min(1),
    description: z.string().default(''),
  })
  .strict();

export const TerminalCommandPaletteStateSchema = z
  .object({
    query: z.string(),
    selectedIndex: z.int().nonnegative(),
    dismissed: z.boolean(),
  })
  .strict();

export type TerminalCommandDescriptor = z.infer<typeof TerminalCommandDescriptorSchema>;
export type TerminalCommandPaletteState = z.infer<typeof TerminalCommandPaletteStateSchema>;

export function validateTerminalCommands(
  commands: readonly TerminalCommandDescriptor[],
): readonly TerminalCommandDescriptor[] {
  const parsed = commands.map((command) => TerminalCommandDescriptorSchema.parse(command));
  const owners = new Map<string, string>();
  for (const command of parsed) {
    for (const name of [command.id, ...command.aliases]) {
      const owner = owners.get(name);
      if (owner) throw new Error(`Terminal command ${name} collides with ${owner}`);
      owners.set(name, command.id);
    }
  }
  return parsed;
}
export function createTerminalCommandPalette(): TerminalCommandPaletteState {
  return { query: '', selectedIndex: 0, dismissed: false };
}

export function setTerminalCommandQuery(
  state: TerminalCommandPaletteState,
  query: string,
): TerminalCommandPaletteState {
  TerminalCommandPaletteStateSchema.parse(state);
  return { query, selectedIndex: 0, dismissed: false };
}

export function dismissTerminalCommandPalette(
  state: TerminalCommandPaletteState,
): TerminalCommandPaletteState {
  return { ...TerminalCommandPaletteStateSchema.parse(state), dismissed: true };
}

export function terminalCommandMatches(
  state: TerminalCommandPaletteState,
  commands: readonly TerminalCommandDescriptor[],
  limit = 20,
): readonly TerminalCommandDescriptor[] {
  const current = TerminalCommandPaletteStateSchema.parse(state);
  if (current.dismissed) return [];
  const parsed = validateTerminalCommands(commands);
  const query = current.query.toLowerCase();
  return parsed
    .filter(
      (command) =>
        command.id.includes(query) ||
        command.label.toLowerCase().includes(query) ||
        command.aliases.some((alias) => alias.includes(query)),
    )
    .slice(0, z.int().positive().parse(limit));
}

export function moveTerminalCommandSelection(
  state: TerminalCommandPaletteState,
  delta: number,
  matchCount: number,
): TerminalCommandPaletteState {
  const current = TerminalCommandPaletteStateSchema.parse(state);
  if (matchCount <= 0) return { ...current, selectedIndex: 0 };
  return {
    ...current,
    selectedIndex: (((current.selectedIndex + delta) % matchCount) + matchCount) % matchCount,
  };
}

export function selectedTerminalCommand(
  state: TerminalCommandPaletteState,
  commands: readonly TerminalCommandDescriptor[],
  limit = 20,
): TerminalCommandDescriptor | undefined {
  const matches = terminalCommandMatches(state, commands, limit);
  return matches[state.selectedIndex] ?? matches[0];
}

export function resolveExactTerminalCommand(
  name: string,
  commands: readonly TerminalCommandDescriptor[],
): TerminalCommandDescriptor | undefined {
  return validateTerminalCommands(commands).find(
    (command) => command.id === name || command.aliases.includes(name),
  );
}
