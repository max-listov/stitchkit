import type { ManagedResource } from './resource';
import { ApplicationIdSchema } from './schemas';

export interface ResolvedManagedResource {
  readonly resource: ManagedResource;
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly required: boolean;
  readonly declarationIndex: number;
}

/** Validate the whole graph before any side effect and return stable topological order. */
export function resolveResourceGraph(
  resources: readonly ManagedResource[],
): readonly ResolvedManagedResource[] {
  const entries = resources.map((resource, declarationIndex) => ({
    resource,
    id: ApplicationIdSchema.parse(resource.id),
    dependsOn: [...(resource.dependsOn ?? [])].map((id) => ApplicationIdSchema.parse(id)),
    required: resource.required ?? true,
    declarationIndex,
  }));
  const byId = new Map<string, ResolvedManagedResource>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`[stitchkit] createApplication: duplicate resource id "${entry.id}"`);
    }
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    for (const dependencyId of entry.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(
          `[stitchkit] createApplication: resource "${entry.id}" depends on missing resource "${dependencyId}"`,
        );
      }
      if (entry.required && !dependency.required) {
        throw new Error(
          `[stitchkit] createApplication: required resource "${entry.id}" cannot depend on optional resource "${dependencyId}"`,
        );
      }
    }
  }

  const pending = new Map(entries.map((entry) => [entry.id, entry]));
  const resolved = new Set<string>();
  const ordered: ResolvedManagedResource[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((entry) => entry.dependsOn.every((id) => resolved.has(id)))
      .sort((left, right) => left.declarationIndex - right.declarationIndex);
    if (ready.length === 0) {
      throw new Error(
        `[stitchkit] createApplication: resource dependency cycle: ${[...pending.keys()].join(', ')}`,
      );
    }
    for (const entry of ready) {
      pending.delete(entry.id);
      resolved.add(entry.id);
      ordered.push(entry);
    }
  }
  return ordered;
}
