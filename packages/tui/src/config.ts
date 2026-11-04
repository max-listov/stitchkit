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
import type { TerminalPalette, TerminalThemeMode } from './core/theme';
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
  /** Colours over the palette of `themeMode`. */
  theme?: Partial<TerminalPalette>;
  /**
   * The terminal background the palette is chosen for. `auto` (the default)
   * asks the terminal and falls back to `dark` when it does not answer.
   */
  themeMode?: TerminalThemeMode | 'auto';
  /** Replace the default durable status rows, or set false to hide them. */
  statusLine?: AgentTuiStatusLineFormatter | false;
}

export function defineAgentTui<CONTEXT>(
  config: AgentTuiConfig<CONTEXT>,
): AgentTuiConfig<CONTEXT> {
  return config;
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
