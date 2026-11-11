import { type ContractFingerprint, contractFingerprint } from '../contract/fingerprint';
import { contractIdentityContract } from '../contract/identity';
import { ApiError } from './api-error';
import { type ClientConfig, type ClientContract, createClient } from './client';
import type { HttpClient } from './http';

/** Both sides of one connection, as each describes the contract it speaks. */
export interface ContractIdentity {
  /** The fingerprint of the contracts this client was built from. */
  client: ContractFingerprint;
  /**
   * The fingerprint the server answered, or `undefined` when the server does
   * not answer the identity operation at all — it predates it or did not mount it.
   */
  server: ContractFingerprint | undefined;
}

/**
 * Read the server's contract fingerprint in one call and return it beside the
 * client's own. A difference is a value to act on, never a throw: Stitchkit
 * computes both identities and the application decides what a mismatch means.
 * A failure to reach the server at all still rejects, as any call does.
 */
export async function readContractIdentity(
  contracts: ClientContract | readonly ClientContract[],
  configOrClient: ClientConfig | HttpClient,
): Promise<ContractIdentity> {
  const client = contractFingerprint(contracts);
  const api = createClient(contractIdentityContract, configOrClient);
  try {
    return { client, server: await api.read() };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return { client, server: undefined };
    throw error;
  }
}
