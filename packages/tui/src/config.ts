import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentConversationReader,
  AgentModelCatalog,
  AgentModelCatalogProvider,
  AgentModelSelection,
  AgentModelSelectionStore,
  AgentRuntimeRecoverOptions,
} from 'stitchkit/agent-runtime';
import { AgentModelSelectionSchema } from 'stitchkit/agent-runtime';
import type { HeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import { z } from 'zod';
import type { AgentTuiCommand } from './commands';
import type { AgentTuiStatusLineFormatter } from './status-line';

const SelectionFileSchema = z
  .object({
    conversationId: z.string().min(1),
    selection: AgentModelSelectionSchema,
  })
  .strict();

export interface AgentTuiRuntimeBundle<CONTEXT> {
  harness: HeadlessAgentHarness<CONTEXT>;
  conversations?: AgentConversationReader;
}

export interface AgentTuiDiagnostics {
  write(value: unknown): void | Promise<void>;
}

export interface AgentTuiConfig<CONTEXT> {
  title?: string;
  workspace?: string;
  /** Explicit durable conversation to open. Omit to start a fresh conversation. */
  initialConversationId?: string;
  preferredModelId?: string;
  context(): CONTEXT | Promise<CONTEXT>;
  modelCatalog: AgentModelCatalogProvider;
  createRuntime(input: {
    catalog: AgentModelCatalog;
    selections: AgentModelSelectionStore;
    diagnostics: AgentTuiDiagnostics;
  }): AgentTuiRuntimeBundle<CONTEXT> | Promise<AgentTuiRuntimeBundle<CONTEXT>>;
  /** Host evidence for acquired runs. The safe default skips anything not still queued. */
  recover?: AgentRuntimeRecoverOptions<CONTEXT>['decide'];
  commands?: readonly AgentTuiCommand[];
  theme?: Partial<AgentTuiTheme>;
  /** Replace the default durable status rows, or set false to hide them. */
  statusLine?: AgentTuiStatusLineFormatter | false;
}

export interface AgentTuiTheme {
  canvas: string;
  panel: string;
  panelRaised: string;
  border: string;
  borderActive: string;
  primary: string;
  muted: string;
  accent: string;
  success: string;
  danger: string;
  warning: string;
}

export const defaultAgentTuiTheme: AgentTuiTheme = {
  canvas: '#111111',
  panel: '#1e2129',
  panelRaised: '#303441',
  border: '#454a57',
  borderActive: '#d9dde7',
  primary: '#e6ebf5',
  muted: '#828aa0',
  accent: '#e58a66',
  success: '#64df98',
  danger: '#ff6b78',
  warning: '#ffd04f',
};

export function defineAgentTui<CONTEXT>(
  config: AgentTuiConfig<CONTEXT>,
): AgentTuiConfig<CONTEXT> {
  return config;
}

export function resolveAgentTuiTheme(theme?: Partial<AgentTuiTheme>): AgentTuiTheme {
  return { ...defaultAgentTuiTheme, ...theme };
}

export function createFileAgentModelSelectionStore(
  workspace: string,
): AgentModelSelectionStore {
  const directory = path.join(workspace, '.stitchkit', 'tui', 'models');
  const filename = (conversationId: string): string =>
    path.join(directory, `${createHash('sha256').update(conversationId).digest('hex')}.json`);
  const load = async (conversationId: string): Promise<AgentModelSelection | undefined> => {
    try {
      const record = SelectionFileSchema.parse(
        JSON.parse(await readFile(filename(conversationId), 'utf8')),
      );
      if (record.conversationId !== conversationId) {
        throw new Error('Agent TUI model selection identity does not match its path');
      }
      return record.selection;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return undefined;
    }
  };
  return {
    load,
    async save(conversationId, rawSelection) {
      const selection = AgentModelSelectionSchema.parse(rawSelection);
      const target = filename(conversationId);
      const record = SelectionFileSchema.parse({ conversationId, selection });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  };
}
