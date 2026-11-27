/**
 * The declarations of a client package: emitted for the entries' own module
 * graph, then made resolvable by every consumer.
 *
 * Two things the compiler leaves undone. It writes a relative specifier into a
 * declaration as the source wrote it — extensionless, or `.ts` — and a consumer
 * under NodeNext resolution needs the `.js` file that declaration stands for;
 * `rewriteRelativeImportExtensions` rewrites emitted JavaScript only. And it
 * writes a bare specifier for every package a public type mentions, whether or
 * not the package declares it, so a type can depend on something the consumer
 * will not have. Both are settled here, by refusal where they cannot be.
 */
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { type ClientBuildStep, type ClientToolCommand, runClientTool } from './client-build';
import { ClientPackageError } from './client-package-contract';
import {
  declarationOutputSpecifier,
  isRelativeSpecifier,
  rewriteDeclarationTree,
} from './declaration-specifiers';

/** What the declaration emit needs from the build. */
export interface ClientDeclarationsInput {
  step: ClientBuildStep;
  tsc: ClientToolCommand;
  /** Absolute path of the project tsconfig. */
  tsconfig: string;
  /** Absolute paths of the entry modules. */
  entries: readonly string[];
  /** Where the declaration tree is written, mirroring the tsconfig's directory. */
  outDir: string;
}

/**
 * Emit declarations for the entries and what they import, and nothing else of
 * the project: an unrelated file with a type error does not fail a client.
 *
 * The generated config sits beside the project's own for the length of the
 * run. Anywhere else, the type roots and `types` the project relies on would be
 * looked up from the wrong directory.
 */
export async function emitClientDeclarations(input: ClientDeclarationsInput): Promise<void> {
  const root = dirname(input.tsconfig);
  const generated = join(root, `.client-package-${randomUUID()}.tsconfig.json`);
  await writeFile(
    generated,
    `${JSON.stringify(
      {
        extends: input.tsconfig,
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          // The archive carries no path of the machine that built it.
          declarationMap: false,
          composite: false,
          incremental: false,
          rootDir: root,
          outDir: input.outDir,
          declarationDir: input.outDir,
        },
        files: input.entries,
        include: [],
      },
      null,
      2,
    )}\n`,
  );
  try {
    const [compiler, ...leading] = input.tsc;
    const emitted = await runClientTool(
      input.step,
      compiler,
      [...leading, '-p', generated],
      root,
    );
    if (!emitted.ok) {
      throw new ClientPackageError(
        'declarations',
        `Client package declarations failed (exit ${emitted.exit}): ${emitted.output}`,
        { output: emitted.output },
      );
    }
  } finally {
    await rm(generated, { force: true });
  }
}

/** The package a bare specifier belongs to: `@scope/name/x` → `@scope/name`. */
function packageOf(specifier: string): string {
  const [first = '', second] = specifier.split('/');
  return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first;
}

/** What the declarations of a package may name besides their own files. */
export interface DeclarationClosure {
  /** Peers and dependencies of the package. */
  packages: ReadonlySet<string>;
  runtime: 'node' | 'bun' | 'browser';
}

function isPlatformModule(specifier: string, closure: DeclarationClosure): boolean {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return true;
  return closure.runtime === 'bun' && (specifier === 'bun' || specifier.startsWith('bun:'));
}

/**
 * Rewrite every relative specifier of the declaration tree to the `.js` file
 * it stands for, and refuse what a consumer could not resolve: a relative
 * module with no declaration in the tree, a `/// <reference path>`, and a
 * package that is neither a peer nor a dependency.
 */
export function normalizeClientDeclarations(
  directory: string,
  closure: DeclarationClosure,
): void {
  rewriteDeclarationTree(directory, (specifier, file) => {
    const shown = relative(directory, file);
    if (specifier.kind === 'reference-types') {
      const declared =
        closure.packages.has(specifier.text) ||
        closure.packages.has(`@types/${specifier.text}`) ||
        specifier.text === 'node' ||
        isPlatformModule(specifier.text, closure);
      if (!declared) throw undeclared(shown, specifier.text, specifier.text);
      return undefined;
    }
    if (specifier.kind === 'reference-path' || isRelativeSpecifier(specifier.text)) {
      const output =
        specifier.kind === 'module'
          ? declarationOutputSpecifier(file, specifier.text)
          : undefined;
      if (output === undefined) {
        throw new ClientPackageError(
          'declaration-unresolved',
          `Client package declaration ${shown} names ${JSON.stringify(specifier.text)}, ` +
            'which has no declaration in the package',
          { file: shown, specifier: specifier.text },
        );
      }
      return output;
    }
    if (isPlatformModule(specifier.text, closure)) return undefined;
    const name = packageOf(specifier.text);
    if (!closure.packages.has(name)) throw undeclared(shown, specifier.text, name);
    return undefined;
  });
}

function undeclared(file: string, specifier: string, name: string): ClientPackageError {
  return new ClientPackageError(
    'declaration-dependency',
    `Client package declaration ${file} names ${JSON.stringify(specifier)}, but "${name}" ` +
      'is neither a peer dependency nor a dependency of the package',
    { file, specifier, package: name },
  );
}
