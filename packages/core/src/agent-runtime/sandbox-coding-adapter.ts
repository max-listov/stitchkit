import {
  type AgentProcessSandbox,
  type AgentSandboxGrade,
  missingSandboxRestrictions,
  probeAgentProcessSandbox,
} from './sandbox';
import { bubblewrapArgs } from './sandbox-bubblewrap-args';
import { sandboxCommandCwd } from './sandbox-coding';
import { SandboxError, type SandboxNetworkPolicy } from './sandbox-contract';
import type { sandboxProcessOwner } from './sandbox-process-owner';

export function createSandboxCodingAdapter(input: {
  workspace: string;
  socket: string;
  executable: string;
  getPolicy(): SandboxNetworkPolicy;
  processes: ReturnType<typeof sandboxProcessOwner>;
  assertActive(): void;
}) {
  const { workspace, socket, executable, getPolicy, processes, assertActive } = input;
  let policyRevision = 0;
  const preparations = new WeakMap<object, number>();
  const grade = (): AgentSandboxGrade => ({
    grade: 'full',
    restrictions:
      getPolicy() === 'deny-all'
        ? ['network-denied', 'write-contained', 'secrets-hidden', 'process-contained']
        : ['write-contained', 'secrets-hidden', 'process-contained'],
  });
  const adapter: AgentProcessSandbox = {
    probe: grade,
    prepare(command) {
      assertActive();
      if (missingSandboxRestrictions(grade(), command.required ?? []).length)
        throw new SandboxError(
          'SANDBOX_NETWORK_DENIED',
          'Sandbox policy no longer satisfies required restrictions',
        );
      const environment = {};
      preparations.set(environment, policyRevision);
      return {
        executable,
        args: bubblewrapArgs({
          workspace: workspace,
          socket,
          network: getPolicy(),
          command: {
            executable: command.executable,
            args: [...command.args],
            cwd: sandboxCommandCwd(workspace, command.cwd),
            environment: { ...command.environment },
          },
        }),
        environment,
      };
    },
    spawn(command) {
      assertActive();
      if (preparations.get(command.environment) !== policyRevision)
        throw new SandboxError(
          'SANDBOX_BUSY',
          'Sandbox policy changed after command preparation',
        );
      preparations.delete(command.environment);
      return processes.spawn(command);
    },
  };

  return {
    adapter,
    async refresh() {
      policyRevision++;
      await probeAgentProcessSandbox(adapter, { refresh: true });
    },
  };
}
