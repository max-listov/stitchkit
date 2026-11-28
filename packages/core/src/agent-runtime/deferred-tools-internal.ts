import type { AgentToolSet } from '../tools/agent-tools';
import type {
  AgentToolCallRepairFunction,
  AgentToolCallRepairInput,
} from './models-driver-step';

const DEFERRED_REPAIR_SYMBOL = Symbol.for('stitchkit.agent-runtime.deferred-repair');
const DEFERRED_CATALOG_SYMBOL = Symbol.for('stitchkit.agent-runtime.deferred-catalog');

/** Attach a first-class repair hook directly on a `prepareStep` function (no WeakMap registry). */
export function registerDeferredToolRepair(
  prepareStep: object,
  repair: AgentToolCallRepairFunction,
): void {
  Object.defineProperty(prepareStep, DEFERRED_REPAIR_SYMBOL, {
    value: repair,
    enumerable: false,
    configurable: true,
  });
}

export function deferredToolRepair(
  prepareStep: object | undefined,
): AgentToolCallRepairFunction | undefined {
  if (!prepareStep) return undefined;
  const candidate = Reflect.get(prepareStep, DEFERRED_REPAIR_SYMBOL);
  return typeof candidate === 'function' ? candidate : undefined;
}

export function registerDeferredToolCatalog(
  tools: AgentToolSet,
  searchName: string,
  names: ReadonlySet<string>,
): void {
  const search = tools[searchName];
  if (search && typeof search === 'object') {
    Object.defineProperty(search, DEFERRED_CATALOG_SYMBOL, {
      value: names,
      enumerable: false,
      configurable: true,
    });
  }
}

export function deferredToolCatalog(
  tools: AgentToolSet,
  searchName: string,
): ReadonlySet<string> | undefined {
  const search = tools[searchName];
  if (!search || typeof search !== 'object') return undefined;
  const candidate = Reflect.get(search, DEFERRED_CATALOG_SYMBOL);
  return candidate instanceof Set ? candidate : undefined;
}

export function repairedSearchCall(
  toolCall: AgentToolCallRepairInput['toolCall'],
  searchName: string,
): AgentToolCallRepairInput['toolCall'] {
  return {
    ...toolCall,
    toolName: searchName,
    input: JSON.stringify({ query: toolCall.toolName, reason: 'inactive_call' }),
  };
}
