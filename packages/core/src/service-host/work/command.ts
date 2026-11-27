import { z } from 'zod';
import { workRootCommand } from '../../process/work-root';
import type { SystemdScope } from '../systemd-render-shared';
import { WorkLaunchError } from './errors';
import { createDefaultWorkHost, type WorkHost } from './host';
import { encodeWorkOrigin, WORK_ORIGIN_ENV, workOriginPrefix } from './origin';
import { WorkOwnerSchema, type WorkRef } from './owner';
import { WorkPlacementSchema } from './placement';
import {
  assertSystemdRunVersion,
  managerEnv,
  resolveCallerSlice,
  SYSTEMD_RUN_PATH,
  scopeCommandArgs,
  workUnitName,
} from './scope-command';

const WorkCommandInputSchema = z.strictObject({
  owner: WorkOwnerSchema,
  placement: WorkPlacementSchema,
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()),
});
/**
 * Input to `workCommand`: who owns the work, where it goes, and the command with the
 * environment it is given. `env` is written out — `{}` for none — because the result extends it.
 */
export type WorkCommandInput = z.input<typeof WorkCommandInputSchema>;

/**
 * A command placed in its boundary, for any spawner: the argv to run and the environment to
 * run it with. `unit` names the scope, or is `null` for a process root.
 */
export interface WorkCommand {
  readonly executable: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly work: WorkRef;
  readonly unit: { readonly manager: SystemdScope; readonly name: string } | null;
}

/** {@link workCommand} against an injected host. */
export async function workCommandWith(
  host: WorkHost,
  input: WorkCommandInput,
): Promise<WorkCommand> {
  const { owner, placement, executable, args, env } = WorkCommandInputSchema.parse(input);
  const work: WorkRef = { launcher: owner.launcher, id: owner.id };
  if (placement.kind === 'process-root') {
    if (host.platform !== 'linux' && host.platform !== 'darwin')
      throw new WorkLaunchError('platform-unsupported', 'A process root needs Linux or macOS');
    if (!host.canReplaceProcess)
      throw new WorkLaunchError(
        'platform-unsupported',
        'A process root needs a runtime with process.execve',
      );
    const [root, ...rootArgs] = workRootCommand({
      variable: WORK_ORIGIN_ENV,
      origin: workOriginPrefix(work),
      executable,
      args,
    });
    return { executable: root, args: rootArgs, env: { ...env }, work, unit: null };
  }
  await assertSystemdRunVersion(host);
  const unit = workUnitName(work);
  const slice =
    placement.slice === 'caller'
      ? await resolveCallerSlice(host, placement.manager)
      : placement.slice;
  return {
    executable: SYSTEMD_RUN_PATH,
    args: scopeCommandArgs({
      manager: placement.manager,
      unit,
      description: owner.label,
      slice,
      limits: placement.limits,
      executable,
      args,
    }),
    env: {
      ...env,
      ...(await managerEnv(host, placement.manager)),
      [WORK_ORIGIN_ENV]: encodeWorkOrigin({
        v: 1,
        work,
        boundary: { kind: 'transient-scope', manager: placement.manager, unit },
      }),
    },
    work,
    unit: { manager: placement.manager, name: unit },
  };
}

/**
 * Wraps a command so that whoever spawns it — a terminal multiplexer, a remote shell, another
 * supervisor — starts it inside its boundary. On Linux the result is a `systemd-run --scope`
 * line; for a process root it is the package's own root entry, which replaces itself with the
 * command. The returned `env` carries `STITCHKIT_WORK_ORIGIN` for a scope; a process root writes
 * the variable itself, once it knows its own process instance.
 */
export function workCommand(input: WorkCommandInput): Promise<WorkCommand> {
  return workCommandWith(createDefaultWorkHost(), input);
}
