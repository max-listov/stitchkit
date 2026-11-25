import { AgentMessageSchema } from './schemas';
import type { AgentRuntimeStore } from './store';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';

/**
 * Once-only seeding: replay idempotency, compaction survival under both the same
 * key (seed receipt) and a fresh key (`driver.history.hasMessage`), and settled
 * exchanges placed ahead of an active run.
 */
export async function seedScenario(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const input = {
    conversationId,
    seedKey: 'brief',
    inputs: [userMessage(conversationId, 'seed-a'), userMessage(conversationId, 'seed-b')],
  };
  const first = await store.seedConversationInput(input);
  requireOutcome(first, 'applied');
  const before = await store.loadSnapshot(conversationId);
  if (before.messages.map((message) => message.id).join(',') !== 'seed-a,seed-b')
    throw new Error('Seed conformance: complete ordered seed missing');
  await Promise.all([store.seedConversationInput(input), store.seedConversationInput(input)]);
  const repeated = await store.loadSnapshot(conversationId);
  if (repeated.version !== before.version || repeated.messages.length !== 2)
    throw new Error('Seed conformance: replay changed history');
  const compacted = await store.replaceCompactedRange({
    conversationId,
    expectedVersion: repeated.version,
    replacedMessageIds: ['seed-a', 'seed-b'],
    summary: AgentMessageSchema.parse({
      ...userMessage(conversationId, 'seed-summary'),
      role: 'summary',
    }),
  });
  requireOutcome(compacted, 'applied');
  const compactedVersion = compacted.snapshot.version;
  await store.seedConversationInput(input);
  const after = await store.loadSnapshot(conversationId);
  if (
    after.version !== compactedVersion ||
    after.messages.some((message) => message.id === 'seed-a' || message.id === 'seed-b')
  )
    throw new Error('Seed conformance: compacted instructions resurrected');
  // A fresh seedKey with the same compacted message identities bypasses the
  // receipt lookup and depends on `driver.history.hasMessage`: inactive rows
  // must stay compacted rather than resurrecting into active history.
  const rekeyed = await store.seedConversationInput({
    ...input,
    seedKey: 'brief-rekeyed',
  });
  requireOutcome(rekeyed, 'applied');
  const afterRekeyed = await store.loadSnapshot(conversationId);
  if (
    afterRekeyed.version !== compactedVersion ||
    afterRekeyed.messages.some((message) => message.id === 'seed-a' || message.id === 'seed-b')
  )
    throw new Error(
      'Seed conformance: compacted instructions resurrected under a new seedKey',
    );
  await settledExchangeScenario(store, conversationId);
}

/**
 * A keyed exchange completed without a model lands after the settled history:
 * at the tail with no active run, and ahead of an active run's input otherwise.
 */
async function settledExchangeScenario(
  store: AgentRuntimeStore,
  conversationId: string,
): Promise<void> {
  const exchange = (key: string) => ({
    conversationId,
    seedKey: key,
    placement: 'after-settled' as const,
    inputs: [
      userMessage(conversationId, `${key}-user`),
      AgentMessageSchema.parse({
        ...userMessage(conversationId, `${key}-assistant`),
        role: 'assistant',
        status: 'completed',
      }),
    ],
  });
  const order = async () =>
    (await store.loadSnapshot(conversationId)).messages.map((message) => message.id).join(',');
  requireOutcome(await store.seedConversationInput(exchange('tail')), 'applied');
  if ((await order()) !== 'seed-summary,tail-user,tail-assistant')
    throw new Error('Settled exchange conformance: an idle conversation did not append it');
  requireOutcome(
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'settled-exchange-run',
      input: userMessage(conversationId, 'queued-input'),
      run: queuedRun(conversationId, 'queued-input', 'queued-run'),
    }),
    'applied',
  );
  await Promise.all([
    store.seedConversationInput(exchange('ahead')),
    store.seedConversationInput(exchange('ahead')),
  ]);
  if (
    (await order()) !==
    'seed-summary,tail-user,tail-assistant,ahead-user,ahead-assistant,queued-input'
  )
    throw new Error(
      'Settled exchange conformance: it must land once, ahead of the active run input',
    );
}
