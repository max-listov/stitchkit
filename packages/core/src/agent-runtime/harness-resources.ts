import {
  type AgentHarnessLimits,
  AgentHarnessLimitsSchema,
  type AgentHarnessResource,
  AgentHarnessResourceDiagnosticSchema,
  type AgentHarnessResourceResult,
  AgentHarnessResourceSchema,
} from './harness-contract';

const DEFAULT_LIMITS: AgentHarnessLimits = {
  maxResources: 64,
  maxResourceBytes: 1_048_576,
  maxDiagnostics: 128,
};

export function resolveHarnessLimits(
  input: Partial<AgentHarnessLimits> | undefined,
): AgentHarnessLimits {
  return AgentHarnessLimitsSchema.parse({ ...DEFAULT_LIMITS, ...input });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateHarnessResources(
  result: AgentHarnessResourceResult,
  limits: AgentHarnessLimits,
): AgentHarnessResourceResult {
  if (result.resources.length > limits.maxResources) {
    throw new Error('Agent harness resource count exceeds maxResources');
  }
  if (result.diagnostics.length > limits.maxDiagnostics) {
    throw new Error('Agent harness diagnostic count exceeds maxDiagnostics');
  }
  const resources = AgentHarnessResourceSchema.array().parse(result.resources);
  const diagnostics = AgentHarnessResourceDiagnosticSchema.array().parse(result.diagnostics);
  const names = new Set<string>();
  let bytes = 0;
  for (const resource of resources) {
    if (names.has(resource.name)) {
      throw new Error(`Duplicate Agent harness resource: ${resource.name}`);
    }
    names.add(resource.name);
    bytes += utf8Bytes(resource.text);
    if (bytes > limits.maxResourceBytes) {
      throw new Error('Agent harness resources exceed maxResourceBytes');
    }
  }
  return { resources, diagnostics };
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderHarnessResources(resources: readonly AgentHarnessResource[]): string {
  return resources
    .map(
      (resource) =>
        `<resource kind="${resource.kind}" name="${xmlAttribute(resource.name)}" provenance="${xmlAttribute(resource.provenance)}">\n${resource.text}\n</resource>`,
    )
    .join('\n');
}
