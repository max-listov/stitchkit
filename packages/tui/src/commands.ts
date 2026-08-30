import { z } from 'zod';
import {
  createTerminalCommandPalette,
  moveTerminalCommandSelection,
  setTerminalCommandQuery,
  terminalCommandMatches,
  validateTerminalCommands,
} from './core/command-palette';

export const AgentTuiCommandOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submit'), text: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('dialog'),
      dialog: z.string().min(1),
      query: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('notice'), message: z.string() }).strict(),
  z.object({ type: z.literal('action'), action: z.string().min(1) }).strict(),
]);

export type AgentTuiCommandOutcome = z.infer<typeof AgentTuiCommandOutcomeSchema>;

export interface AgentTuiCommandContext {
  conversationId: string;
  activeRunId?: string;
}

export interface AgentTuiCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  available?(context: AgentTuiCommandContext): boolean;
  complete?(query: string): readonly string[];
  execute(
    argumentsText: string,
    context: AgentTuiCommandContext,
  ): AgentTuiCommandOutcome | Promise<AgentTuiCommandOutcome>;
}

export function defineTuiCommand(command: AgentTuiCommand): AgentTuiCommand {
  if (!/^[a-z][a-z0-9-]*$/.test(command.name)) {
    throw new Error('TUI command names use lowercase letters, digits and hyphens');
  }
  for (const alias of command.aliases ?? []) {
    if (alias !== '?' && !/^[a-z][a-z0-9-]*$/.test(alias)) {
      throw new Error('TUI command aliases are invalid');
    }
  }
  return command;
}

export function composeTuiCommands(
  ...groups: readonly (readonly AgentTuiCommand[])[]
): readonly AgentTuiCommand[] {
  const commands = groups.flat();
  validateTerminalCommands(
    commands.map((command) => ({
      id: defineTuiCommand(command).name,
      aliases: [...(command.aliases ?? [])],
      label: command.name,
      description: command.description,
    })),
  );
  return commands;
}

export type AgentTuiCommandResolution =
  | { type: 'prompt'; text: string }
  | { type: 'command'; command: AgentTuiCommand; argumentsText: string };

export function resolveTuiCommand(
  text: string,
  commands: readonly AgentTuiCommand[],
): AgentTuiCommandResolution {
  if (!text.startsWith('/')) return { type: 'prompt', text };
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const name = match?.[1];
  if (!name) return { type: 'prompt', text };
  const command = commands.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  return command
    ? { type: 'command', command, argumentsText: match?.[2] ?? '' }
    : { type: 'prompt', text };
}

export function commandCompletions(
  text: string,
  commands: readonly AgentTuiCommand[],
): readonly AgentTuiCommand[] {
  if (!text.startsWith('/') || text.slice(1).includes(' ')) return [];
  const state = setTerminalCommandQuery(createTerminalCommandPalette(), text.slice(1));
  const descriptors = terminalCommandMatches(
    state,
    commands.map((command) => ({
      id: command.name,
      aliases: [...(command.aliases ?? [])],
      label: command.name,
      description: command.description,
    })),
    Math.max(1, commands.length),
  );
  return descriptors
    .map((descriptor) => commands.find((command) => command.name === descriptor.id))
    .filter((command): command is AgentTuiCommand => command !== undefined);
}

export function selectedCommandCompletion(
  text: string,
  commands: readonly AgentTuiCommand[],
  selectedIndex: number,
): AgentTuiCommand | undefined {
  const completions = commandCompletions(text, commands);
  return completions[selectedIndex] ?? completions[0];
}

export function moveCommandCompletionSelection(
  selectedIndex: number,
  direction: 'previous' | 'next',
  completionCount: number,
): number {
  if (completionCount <= 0) return 0;
  return moveTerminalCommandSelection(
    { query: '', selectedIndex, dismissed: false },
    direction === 'previous' ? -1 : 1,
    completionCount,
  ).selectedIndex;
}

export function resolveTuiCommandSubmission(
  text: string,
  commands: readonly AgentTuiCommand[],
  selectedIndex: number,
  paletteDismissed = false,
): AgentTuiCommandResolution {
  const completion = paletteDismissed
    ? undefined
    : selectedCommandCompletion(text, commands, selectedIndex);
  return resolveTuiCommand(completion ? `/${completion.name}` : text, commands);
}
