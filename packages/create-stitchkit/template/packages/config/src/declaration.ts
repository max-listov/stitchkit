import source from '../../../project.json' with { type: 'json' };
import { findProjectRole, parseProjectDeclaration } from './project-declaration.generated';

/**
 * What this repository says about itself — the one machine-readable statement
 * that is true with no machine in existence.
 *
 * Ports, hosts, addresses, machine paths and supervision policy are NOT here by
 * construction: the schema has nowhere to put them. A deployment supplies those
 * under the variable names the declaration lists.
 */
export const appDeclaration = parseProjectDeclaration(source);

/**
 * This application's API role.
 *
 * Resolved once, here, so the role's own code can read what the declaration
 * says about it — the drain floor above all — instead of restating it. A
 * declaration without the role is a broken declaration, and saying so at
 * startup beats a silent `undefined` deep inside a shutdown path.
 */
const API_ROLE_NAME = 'api';

export const apiRole = (() => {
  const role = findProjectRole(appDeclaration, API_ROLE_NAME);
  if (!role) {
    throw new Error(`project.json declares no "${API_ROLE_NAME}" role.`);
  }
  return role;
})();
