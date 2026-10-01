import { type GreenGateRecord, writeGreenGate } from './gate-memo';
import { FAST_GATE, FAST_STEPS, type VerifyProfile } from './verify-profiles';

/** Save only successfully completed coverage, keyed by the inputs each gate reads. */
export async function saveGreenEvidence(
  profile: VerifyProfile,
  record: GreenGateRecord,
  runtimeToolchain: string,
  memo: string,
): Promise<void> {
  await writeGreenGate(profile.gate, record, memo);
  if (profile.gate !== FAST_GATE && FAST_STEPS.every((step) => profile.steps.includes(step))) {
    // Portable checks do not depend on PostgreSQL or installed browser versions.
    // A separate attestation avoids weakening heavy gates' environment keys.
    await writeGreenGate(FAST_GATE, { ...record, toolchain: runtimeToolchain }, memo);
  }
}
