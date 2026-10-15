import type { BranchReplay } from './branch-replay';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

export async function persistRuntimeReplay<T>(
  driver: AgentRuntimeStoreDriver<T>,
  tx: T,
  replay: BranchReplay,
) {
  if (replay.baseline) {
    const baseline = replay.baseline;
    for (const record of baseline.runs) await driver.runs.save(tx, record);
    if (driver.history.restore)
      await driver.history.restore(tx, {
        conversationId: baseline.head.conversationId,
        messages: baseline.messages,
        compactedMessageIds: baseline.compacted ?? [],
      });
    else
      for (const message of baseline.messages)
        await driver.history.apply(tx, { type: 'admit', input: message });
    for (const receipt of baseline.admissions) await driver.admissions.create(tx, receipt);
  }
  for (const effect of replay.effects) {
    for (const record of effect.runRecords ?? []) await driver.runs.save(tx, record);
    if (effect.admissionReceipt) await driver.admissions.create(tx, effect.admissionReceipt);
    if (effect.seedReceipt) await driver.seeds.create(tx, effect.seedReceipt);
    for (const mutation of effect.historyMutations ?? [])
      await driver.history.apply(tx, mutation);
  }
}
