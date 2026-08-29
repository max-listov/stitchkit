import type { ToolCallRepairFunction, ToolSet } from 'ai';

type RepairToolCall = Parameters<ToolCallRepairFunction<ToolSet>>[0]['toolCall'];

const repairs = new WeakMap<object, ToolCallRepairFunction<ToolSet>>();
const catalogs = new WeakMap<object, ReadonlySet<string>>();

/** Immutable controller metadata; durable activation never lives here. */
export function registerDeferredToolRepair(
  prepareStep: object,
  repair: ToolCallRepairFunction<ToolSet>,
): void {
  repairs.set(prepareStep, repair);
}

export function deferredToolRepair(
  prepareStep: object | undefined,
): ToolCallRepairFunction<ToolSet> | undefined {
  return prepareStep ? repairs.get(prepareStep) : undefined;
}

export function registerDeferredToolCatalog(
  tools: ToolSet,
  searchName: string,
  names: ReadonlySet<string>,
): void {
  const search = tools[searchName];
  if (search && typeof search === 'object') catalogs.set(search, names);
}

export function deferredToolCatalog(
  tools: ToolSet,
  searchName: string,
): ReadonlySet<string> | undefined {
  const search = tools[searchName];
  return search && typeof search === 'object' ? catalogs.get(search) : undefined;
}

export function repairedSearchCall(
  toolCall: RepairToolCall,
  searchName: string,
): RepairToolCall {
  return {
    ...toolCall,
    toolName: searchName,
    input: JSON.stringify({ query: toolCall.toolName, reason: 'inactive_call' }),
  };
}
