import { agentConversationProofs } from './agent-conversation-proofs';
import type { InstalledConsumerProof } from './installed-proof-contract';
import { requestBoundaryProofs } from './request-boundary-proofs';

/** The proofs registered by subject, ahead of the shared list in `installed-proofs.ts`. */
export const proofGroups: InstalledConsumerProof[] = [
  ...agentConversationProofs,
  ...requestBoundaryProofs,
];
