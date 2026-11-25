/**
 * The optional driver members a store declares, proven by behaviour: an archive's
 * companions round trip, compacted history is restored inactive, and a store without
 * the member refuses with `AgentStoreUnsupportedCapabilityError` and writes nothing.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentMessageSchema } from './schemas';
import type { AgentRuntimeStore } from './store';
import {
  type AgentStoreOptionalCapability,
  AgentStoreUnsupportedCapabilityError,
} from './store-capabilities';
import { queuedRun, requireOutcome, userMessage } from './store-conformance-support';
import {
  type AgentConversationArchive,
  canonicalAgentJson,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from './store-events';
import { createMemoryAgentRuntimeStore } from './store-memory';

const at = '2026-08-22T00:00:00.000Z';
const COMPANION = 'conformance-companion';

async function refusedAndEmpty(
  store: AgentRuntimeStore,
  conversationId: string,
  bytes: Uint8Array,
  capability: AgentStoreOptionalCapability,
): Promise<void> {
  let failure: unknown;
  try {
    await store.importConversation(bytes);
  } catch (error) {
    failure = error;
  }
  if (
    !(failure instanceof AgentStoreUnsupportedCapabilityError) ||
    failure.capability !== capability
  ) {
    const received =
      failure === undefined
        ? 'a successful import'
        : failure instanceof Error
          ? `${failure.name}: ${failure.message}`
          : String(failure);
    throw new Error(
      `Agent store conformance: a store without ${capability} must refuse with AgentStoreUnsupportedCapabilityError('${capability}'), received ${received}`,
    );
  }
  const [events, snapshot] = await Promise.all([
    store.readEvents({ conversationId, limit: 1 }),
    store.loadSnapshot(conversationId),
  ]);
  if (events.items.length > 0 || snapshot.version !== 0 || snapshot.messages.length > 0)
    throw new Error(
      `Agent store conformance: a refused ${capability} import must leave the conversation empty, found ${events.items.length} events and version ${snapshot.version}`,
    );
}

/** A spill and a companion projection travel through import and export unchanged. */
export async function archiveCapabilityScenario(
  store: AgentRuntimeStore,
  conversationId: string,
  declared: boolean,
): Promise<void> {
  const origin = createMemoryAgentRuntimeStore();
  requireOutcome(
    await origin.acceptInputAndAssignRun({
      idempotencyKey: 'companion-request',
      input: userMessage(conversationId, 'companion-input'),
      run: queuedRun(conversationId, 'companion-input', 'companion-run'),
    }),
    'applied',
  );
  const archive = decodeAgentConversationArchive(
    await origin.exportConversation(conversationId),
  );
  const reference = `${conversationId}-spill`;
  const spill = {
    reference,
    runId: 'companion-run',
    bytes: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
    base64: 'YWJj',
    mediaType: 'text/plain',
    createdAt: at,
  };
  const companion = {
    name: COMPANION,
    version: 1,
    uptoSeq: 1,
    value: { kept: true },
    updatedAt: at,
  };
  archive.spills = [spill];
  archive.projections = [...archive.projections, companion];
  const bytes = encodeAgentConversationArchive(archive);
  if (!declared) {
    await refusedAndEmpty(store, conversationId, bytes, 'archive');
    return;
  }
  await store.importConversation(bytes);
  const exported = decodeAgentConversationArchive(
    await store.exportConversation(conversationId),
  );
  // Whole and exact: a payload, a run link or a projection watermark that changes
  // on the way through is a lost companion, even when its name still matches.
  const same = (left: unknown, right: unknown) =>
    canonicalAgentJson(left) === canonicalAgentJson(right);
  const lost = [
    ...(exported.spills.some((entry) => same(entry, spill)) ? [] : ['its spill']),
    ...(exported.projections.some((entry) => same(entry, companion))
      ? []
      : ['its companion projection']),
  ];
  if (lost.length > 0)
    throw new Error(
      `Agent store conformance: capabilities.archive is true, but the archive changed ${lost.join(
        ' and ',
      )} on import and export`,
    );
}

/** A migrated baseline with a compacted row: restored inactive, never active again. */
export async function historyRestoreCapabilityScenario(
  store: AgentRuntimeStore,
  conversationId: string,
  declared: boolean,
): Promise<void> {
  const input = userMessage(conversationId, 'restored-input');
  const summary = AgentMessageSchema.parse({
    ...userMessage(conversationId, 'restored-summary'),
    role: 'summary',
  });
  const head = { schemaVersion: 1, conversationId, version: 2 };
  const archive: AgentConversationArchive = {
    format: 'stitchkit.agent-conversation',
    formatVersion: 1,
    conversationId,
    events: [
      {
        schemaVersion: 1,
        eventId: `${conversationId}-baseline`,
        conversationId,
        seq: 1,
        kind: 'runtime/baseline',
        occurredAt: at,
        payload: z.json().parse({
          migratedAt: at,
          head,
          messages: [input, summary],
          compacted: [input.id],
          runs: [],
          admissions: [],
        }),
      },
    ],
    projections: [
      {
        archiveType: 'runtime-snapshot',
        snapshot: z.json().parse({ ...head, messages: [summary], runs: [] }),
      },
    ],
    spills: [],
  };
  const bytes = encodeAgentConversationArchive(archive);
  if (!declared) {
    await refusedAndEmpty(store, conversationId, bytes, 'historyRestore');
    return;
  }
  await store.importConversation(bytes);
  const active = async () =>
    (await store.loadSnapshot(conversationId)).messages.map((message) => message.id).join(',');
  if ((await active()) !== summary.id)
    throw new Error(
      `Agent store conformance: capabilities.historyRestore is true, but a compacted baseline row came back active (${await active()})`,
    );
  // A fresh seed key with the compacted identity must find it, not resurrect it.
  requireOutcome(
    await store.seedConversationInput({
      conversationId,
      seedKey: 'restored-rekeyed',
      inputs: [input],
    }),
    'applied',
  );
  if ((await active()) !== summary.id)
    throw new Error(
      'Agent store conformance: a seed resurrected a compacted row restored from a baseline',
    );
}
