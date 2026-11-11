import {
  type ContractFingerprint,
  type FingerprintedOperation,
  fingerprintOperations,
} from '../contract/fingerprint';
import { contractIdentityContract } from '../contract/identity';
import { implement } from './implement';
import type { ServiceDef } from './types';

function serviceOperations(services: readonly ServiceDef[]): FingerprintedOperation[] {
  const operations: FingerprintedOperation[] = [];
  for (const service of services) {
    for (const method of Object.values(service.methods)) {
      if (method.expose && !method.expose.includes('HTTP')) continue;
      operations.push({
        name: `${method.serviceName}.${method.key}`,
        method: method.method,
        path: method.path,
        params: method.paramsSchema,
        input: method.inputSchema,
        output: method.outputSchema,
        item: method.stream?.item,
      });
    }
  }
  return operations;
}

/**
 * `services` plus the service that answers `contractIdentityContract` with their
 * fingerprint — the same digest `contractFingerprint` gives a client holding
 * the same contracts. It returns the whole list to mount, so the identity
 * cannot describe a different set of services than the server answers. The
 * identity operation is not part of its own answer.
 */
export function withContractIdentity(services: readonly ServiceDef[]): ServiceDef[] {
  let fingerprint: ContractFingerprint | undefined;
  return [
    ...services,
    implement(contractIdentityContract, {
      read: () => {
        fingerprint ??= fingerprintOperations(serviceOperations(services));
        return fingerprint;
      },
    }),
  ];
}
