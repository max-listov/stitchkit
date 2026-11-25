import { relative, sep } from 'node:path';
import type { AgentProcessSandbox } from './sandbox';
import { sandboxPath } from './sandbox-session';

/** The host workspace a sandbox lends to coding tools. */
export interface SandboxCodingBinding {
  /** Trusted host path; never expose this binding to a model. */
  root: string;
  adapter: AgentProcessSandbox;
  assertActive(): void;
}

export function sandboxCommandCwd(root: string, cwd: string) {
  const path = relative(root, cwd).split(sep).join('/');
  return sandboxPath(path || '.');
}
