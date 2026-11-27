/**
 * Work launched in its own boundary with a declared owner: a transient systemd scope on Linux
 * or a recorded process root, the typed owner record, the one inherited variable that names the
 * boundary, and the check that asks the boundary whether a process belongs to it.
 */

export {
  type WorkCommand,
  type WorkCommandInput,
  workCommand,
} from '../../service-host/work/command';
export { WorkLaunchError, type WorkLaunchErrorReason } from '../../service-host/work/errors';
export {
  launchWork,
  type WorkLaunch,
  type WorkLaunchCommand,
  type WorkLaunchInput,
} from '../../service-host/work/launch';
export {
  checkWorkMembership,
  inheritedWork,
  type WorkMembership,
  type WorkMembershipUnavailableReason,
} from '../../service-host/work/membership';
export {
  readWorkOrigin,
  WORK_ORIGIN_ENV,
  type WorkBoundary,
  WorkBoundarySchema,
  type WorkOrigin,
  WorkOriginSchema,
} from '../../service-host/work/origin';
export {
  type WorkAgent,
  WorkAgentSchema,
  type WorkOwner,
  WorkOwnerSchema,
  type WorkRef,
  WorkRefSchema,
} from '../../service-host/work/owner';
export type {
  WorkPlacement,
  WorkScopeLimits,
  WorkScopePlacement,
} from '../../service-host/work/placement';
export {
  probeWorkBoundary,
  type WorkBoundaryAvailability,
} from '../../service-host/work/probe';
export { workUnitName } from '../../service-host/work/scope-command';
