import type { z } from 'zod';
import type { JsonRpcPeer } from '../json-rpc-peer';
import {
  type AcpConfigOption,
  type AcpSessionStateSchema,
  AcpSetConfigOptionResultSchema,
  acpOptionValues,
} from './v1-protocol';

/** The option of a category (`model`, `thought_level`, `mode`), or the one with that id. */
function optionOf(options: readonly AcpConfigOption[], category: string) {
  return (
    options.find((option) => option.category === category) ??
    options.find((option) => option.id === category)
  );
}

/** Merge initial `configOptions` from `session/new` / `session/load` with any earlier `config_option_update`. */
export function mergeInitialAcpConfigOptions(
  current: readonly AcpConfigOption[],
  incoming: readonly AcpConfigOption[] | null | undefined,
  sawConfigOptionUpdate: boolean,
): readonly AcpConfigOption[] {
  if (incoming == null) return current;
  if (!sawConfigOptionUpdate || (current.length === 0 && incoming.length > 0)) {
    return incoming;
  }
  return current;
}

/** Update one ACP config option on an open session, returning the agent's latest option list. */
export async function setAcpConfigOption(
  peer: JsonRpcPeer,
  sessionId: string,
  options: readonly AcpConfigOption[],
  category: string,
  value: string,
  signal?: AbortSignal,
): Promise<readonly AcpConfigOption[]> {
  const option = optionOf(options, category);
  if (option === undefined) throw new Error(`The ACP agent offers no ${category} option`);
  const values = acpOptionValues(option);
  if (values.length > 0 && !values.includes(value)) {
    throw new Error(
      `The ACP agent's ${category} option has no value ${value} (offered: ${values.join(', ')})`,
    );
  }
  const answer = AcpSetConfigOptionResultSchema.parse(
    await peer.request(
      'session/set_config_option',
      { sessionId, configId: option.id, value },
      signal !== undefined ? { signal } : undefined,
    ),
  );
  return answer.configOptions ?? options;
}

/** Apply initial `model`, `thoughtLevel`, and `mode` selections right after opening a session. */
export async function applyAcpSessionSelections(input: {
  peer: JsonRpcPeer;
  sessionId: string;
  configOptions: readonly AcpConfigOption[];
  models: z.infer<typeof AcpSessionStateSchema>['models'];
  signal: AbortSignal;
  model?: string;
  thoughtLevel?: string;
  mode?: string;
}): Promise<readonly AcpConfigOption[]> {
  let options = input.configOptions;
  const setCat = (category: string, value: string) =>
    setAcpConfigOption(input.peer, input.sessionId, options, category, value, input.signal);
  if (input.model !== undefined) {
    if (optionOf(options, 'model') !== undefined) {
      options = await setCat('model', input.model);
    } else if (input.models !== undefined && input.models !== null) {
      const available = input.models.availableModels?.map((entry) => entry.modelId) ?? [];
      if (available.length > 0 && !available.includes(input.model)) {
        throw new Error(
          `The ACP agent's model option has no value ${input.model} (offered: ${available.join(', ')})`,
        );
      }
      await input.peer.request(
        'session/set_model',
        { sessionId: input.sessionId, modelId: input.model },
        { signal: input.signal },
      );
    } else {
      throw new Error('The ACP agent offers no model option');
    }
  }
  if (input.thoughtLevel !== undefined)
    options = await setCat('thought_level', input.thoughtLevel);
  if (input.mode !== undefined) options = await setCat('mode', input.mode);
  return options;
}
