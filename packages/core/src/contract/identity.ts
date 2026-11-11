import { defineContract } from './define';
import { ContractFingerprintSchema } from './fingerprint';

/**
 * The operation a server answers its own contract fingerprint with.
 *
 * A contract like any other, so every transport that carries a contract —
 * HTTP, a Unix socket — carries the identity too, through the same typed
 * client. A server mounts it by choice (`withContractIdentity`): the
 * answer lists operation names.
 */
export const contractIdentityContract = defineContract(
  { prefix: 'contract-identity', scope: 'public' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'The fingerprint of the contract operations this server answers',
      expose: ['HTTP'],
      output: ContractFingerprintSchema,
    },
  },
);
