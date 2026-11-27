import type { ExecutorDriverCapabilities } from '../hello';

/** What a Codex driver declares; `images` follows whether the host can resolve a file part. */
export function codexDriverCapabilities(options: {
  readonly images: boolean;
}): ExecutorDriverCapabilities {
  return {
    runtimePolicyEnforcement: 'native',
    sessionApproval: true,
    interruptOnDeny: true,
    updatedToolInput: false,
    structuredInput: true,
    steer: true,
    fork: true,
    revert: true,
    compact: true,
    injectItems: true,
    backgroundWorkOutlivesTurn: false,
    multiThreadPerProcess: false,
    images: options.images,
    planLimits: 'pull',
  };
}

/** A driver's capabilities as its shared server declares them: one process, many threads. */
export function codexSharedServerCapabilities(
  driver: ExecutorDriverCapabilities,
): ExecutorDriverCapabilities {
  return { ...driver, multiThreadPerProcess: true };
}
