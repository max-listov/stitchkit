import {
  type AgentTuiCommand,
  type AgentTuiCommandOutcome,
  defineTuiCommand,
} from './commands';

const dialog = (name: string, query?: string): AgentTuiCommandOutcome => ({
  type: 'dialog',
  dialog: name,
  ...(query && { query }),
});
const action = (name: string): AgentTuiCommandOutcome => ({ type: 'action', action: name });

export function createAgentTuiBuiltinCommands(): readonly AgentTuiCommand[] {
  return [
    defineTuiCommand({
      name: 'help',
      aliases: ['?'],
      description: 'Show available terminal commands',
      execute: () => dialog('help'),
    }),
    defineTuiCommand({
      name: 'model',
      description: 'Choose the model for the next run',
      execute: (query) => dialog('model', query.trim()),
    }),
    defineTuiCommand({
      name: 'new',
      description: 'Start a new durable conversation',
      execute: () => action('new-conversation'),
    }),
    defineTuiCommand({
      name: 'sessions',
      description: 'Browse durable conversations',
      execute: () => dialog('sessions'),
    }),
    defineTuiCommand({
      name: 'resume',
      description: 'Resume a durable conversation',
      execute: () => dialog('sessions'),
    }),
    defineTuiCommand({
      name: 'status',
      description: 'Show session, conversation and run status',
      execute: () => dialog('status'),
    }),
    defineTuiCommand({
      name: 'tools',
      description: 'Show the direct tool surface',
      execute: () => dialog('tools'),
    }),
    defineTuiCommand({
      name: 'skills',
      description: 'Show lazily available skills and resources',
      execute: () => dialog('skills'),
    }),
    defineTuiCommand({
      name: 'permissions',
      description: 'Show approval and sandbox enforcement',
      execute: () => dialog('permissions'),
    }),
    defineTuiCommand({
      name: 'interrupt',
      description: 'Interrupt the active run',
      available: ({ activeRunId }) => activeRunId !== undefined,
      execute: () => action('interrupt'),
    }),
    defineTuiCommand({
      name: 'clear',
      description: 'Start clean while keeping this conversation available to resume',
      execute: () => action('clear-conversation'),
    }),
    defineTuiCommand({
      name: 'quit',
      aliases: ['exit'],
      description: 'Close this terminal host',
      execute: () => action('quit'),
    }),
  ];
}
