/**
 * Make emitted ESM declarations resolvable by NodeNext consumers.
 *
 * Source is compiled with bundler resolution so browser and server entrypoints
 * can keep their established extensionless imports. TypeScript preserves those
 * specifiers in `.d.ts`, while NodeNext correctly requires the ESM file that a
 * relative declaration import represents. Resolve against the completed
 * declaration tree and write the corresponding `.js` specifier; a directory
 * declaration points at its explicit `index.js`.
 *
 * The rewrite itself is the one `buildClientPackage` applies to a client's
 * declarations (`src/files/declaration-specifiers.ts`): one tokenizer, one
 * resolution rule.
 */
import { relative, resolve } from 'node:path';
import {
  declarationOutputSpecifier,
  isRelativeSpecifier,
  rewriteDeclarationTree,
} from '../src/files/declaration-specifiers.ts';

const dist = resolve(import.meta.dirname, '..', 'dist');

const rewritten = rewriteDeclarationTree(dist, (specifier, file) => {
  if (specifier.kind !== 'module' || !isRelativeSpecifier(specifier.text)) return undefined;
  // Data and native modules are named by their own files; no declaration stands for them.
  if (/\.(?:json|node)$/.test(specifier.text)) return undefined;
  const output = declarationOutputSpecifier(file, specifier.text);
  if (output === undefined) {
    throw new Error(
      `[rewrite-declaration-specifiers] ${relative(dist, file)} references unresolved relative declaration ${JSON.stringify(specifier.text)}`,
    );
  }
  return output;
});

console.log(
  `[rewrite-declaration-specifiers] ${rewritten.specifiers} specifiers in ${rewritten.files} declaration files`,
);
