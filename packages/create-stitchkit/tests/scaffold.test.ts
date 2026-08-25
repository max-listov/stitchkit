import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  PROJECT_DECLARATION_SCHEMA_VERSION,
  parseProjectDeclaration,
} from '../../core/src/declaration';
import { APP_IDENTITY_PATH, renderAppIdentityModule } from '../src/identity';
import { isTemplateSourcePathIncluded, scaffoldProject } from '../src/scaffold';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * The smallest declaration a template can carry. The scaffolder rewrites its
 * identity and refuses a template that has none — a project with no declaration
 * is not something a deployment can read.
 */
const MINIMAL_DECLARATION = {
  schemaVersion: PROJECT_DECLARATION_SCHEMA_VERSION,
  kind: 'application',
  identity: {
    slug: 'stitchkit-starter',
    name: 'Stitchkit Starter',
    version: '0.1.0',
    description: { en: 'A starter.' },
  },
  roles: [
    {
      name: 'api',
      workingDirectory: 'packages/backend',
      commands: {
        development: { executable: 'bun', args: ['--watch', 'src/index.ts'] },
        production: { executable: 'bun', args: ['dist/index.js'] },
      },
      drainFloorMs: 1000,
    },
  ],
  requires: [],
  release: {},
  env: { variables: [] },
};

describe('scaffoldProject', () => {
  test('ships one neutral domain-free packages-only application', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const rootManifest = await readFile(join(templateRoot, 'package.json'), 'utf8');
    const backendManifest = await readFile(
      join(templateRoot, 'packages/backend/package.json'),
      'utf8',
    );
    const frontendManifest = await readFile(
      join(templateRoot, 'packages/frontend/package.json'),
      'utf8',
    );

    expect(JSON.parse(rootManifest)).toMatchObject({
      name: 'stitchkit-starter',
      workspaces: ['packages/*'],
      devDependencies: { stitchkit: 'catalog:' },
    });
    expect(backendManifest).toContain('"name": "@app/backend"');
    expect(frontendManifest).toContain('"name": "@app/frontend"');
    expect(`${rootManifest}${backendManifest}${frontendManifest}`).not.toContain('__PROJECT_');
    const sharedIndex = await readFile(
      join(templateRoot, 'packages/shared/src/index.ts'),
      'utf8',
    );
    expect(sharedIndex).not.toContain('repository');
  });

  test('composes the repository example over the domain-free base', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const overlayRoot = join(import.meta.dir, '..', 'examples/repository');
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'app');
    created.push(parent);

    await scaffoldProject(templateRoot, destination, { overlayDirectory: overlayRoot });

    expect(
      await readFile(join(destination, 'packages/shared/src/index.ts'), 'utf8'),
    ).toContain('./contracts/repository');
    expect(await readFile(join(destination, 'packages/db/schema.prisma'), 'utf8')).toContain(
      'model RepositorySnapshot',
    );
    // No `.env` ships — the example appends land in `.env.example`, the
    // single source `env:ensure` renders from.
    const environmentExample = await readFile(join(destination, '.env.example'), 'utf8');
    expect(environmentExample).toContain('CORS_ORIGIN=http://127.0.0.1:3210');
    expect(environmentExample).toContain('GITHUB_REPOSITORY=max-listov/stitchkit');
    // The example extends the environment through the one declaration of it,
    // and the declaration a deployment reads picks the extension up on its own.
    const variables = await readFile(
      join(destination, 'packages/config/src/variables.ts'),
      'utf8',
    );
    expect(variables).toContain('featureServerSchema');
    const features = await readFile(
      join(destination, 'packages/config/src/features.ts'),
      'utf8',
    );
    expect(features).toContain('GITHUB_REPOSITORY');
    expect(await readFile(join(destination, 'scripts/runtime-smoke.ts'), 'utf8')).toContain(
      'runSurfaceConformance',
    );
  });

  test('materialises one validated application identity from the destination', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'talk-control');
    created.push(parent);

    await scaffoldProject(templateRoot, destination, { displayName: 'Talk Control Console' });

    const declaration = parseProjectDeclaration(
      JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')),
    );
    // Parsed with the framework schema, not just compared: the scaffolder must
    // write something the reader that never sees this tree will accept. → ADR 0104
    expect(declaration.schemaVersion).toBe(PROJECT_DECLARATION_SCHEMA_VERSION);
    expect(declaration.identity).toEqual({
      slug: 'talk-control',
      name: 'Talk Control Console',
      version: '0.1.0',
      description: {
        en: 'Talk Control Console is a production application built with Stitchkit.',
        ru: 'Talk Control Console — production-приложение на Stitchkit.',
      },
    });
    // Everything that is true of the CODE travels unchanged from the template.
    expect(declaration.roles.map((role) => role.name)).toEqual(['api', 'web']);
    expect(declaration.release.migrations?.engine).toBe('prisma');

    // The client-safe identity module is DERIVED from the declaration, so it is
    // stamped in the same pass — otherwise a generated project ships the neutral
    // template's name and fails its own generator check.
    const identityModule = await readFile(join(destination, APP_IDENTITY_PATH), 'utf8');
    expect(identityModule).toBe(renderAppIdentityModule(declaration.identity));
    expect(identityModule).toContain('talk-control');
    expect(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).name).toBe(
      'talk-control',
    );
    expect(await readFile(join(destination, 'ecosystem.config.cjs'), 'utf8')).toContain(
      'identity.slug',
    );
    expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toContain(
      'Application agent guide',
    );
    expect(await readFile(join(destination, 'docs/ADDING_A_FEATURE.md'), 'utf8')).toContain(
      'Adding a vertical feature',
    );
  });

  test('ships application-local agent guidance without private or maintainer context', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const overlayRoot = join(import.meta.dir, '..', 'examples/repository');
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    created.push(parent);

    for (const [name, overlayDirectory] of [
      ['blank-app', undefined],
      ['example-app', overlayRoot],
    ] satisfies [string, string | undefined][]) {
      const destination = join(parent, name);
      await scaffoldProject(templateRoot, destination, { overlayDirectory });
      const guidance = `${await readFile(join(destination, 'AGENTS.md'), 'utf8')}\n${await readFile(join(destination, 'docs/ADDING_A_FEATURE.md'), 'utf8')}`;

      expect(guidance).toContain('packages/shared/src/schemas/status.ts');
      expect(guidance).toContain('defineSurfaceProbe');
      // Absolute machine paths and the maintainer's publishing commands are
      // classes, so they can be named.
      expect(guidance).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:[\\/]/);
      expect(guidance).not.toContain('npm publish');
      expect(guidance).not.toContain('git tag');

      // Another project's vocabulary is checked STRUCTURALLY, not by listing
      // names. Writing the names of private projects into a public repository —
      // even inside a test that forbids them — is the leak the rule exists to
      // prevent, and a fixed list only ever catches the three somebody thought
      // of. Every word of the generated guidance must come from the template or
      // from this project's own identity; anything else arrived by accident.
      const templateGuidance = `${await readFile(join(templateRoot, 'AGENTS.md'), 'utf8')}\n${await readFile(join(templateRoot, 'docs/ADDING_A_FEATURE.md'), 'utf8')}`;
      const words = (text: string): string[] => text.match(/[A-Za-z][\w-]*/g) ?? [];
      const fromTemplate = new Set(words(templateGuidance));
      const identity = parseProjectDeclaration(
        JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')),
      ).identity;
      const ownIdentity = new Set([
        ...words(identity.name),
        ...words(identity.slug),
        ...Object.values(identity.description).flatMap(words),
      ]);
      const foreign = [...new Set(words(guidance))].filter(
        (word) => !fromTemplate.has(word) && !ownIdentity.has(word),
      );
      expect(foreign).toEqual([]);
    }
  });

  test('rejects an invalid destination identity before creating files', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'Talk Control');
    created.push(parent);

    await expect(scaffoldProject(templateRoot, destination)).rejects.toThrow(
      'Use lowercase letters, numbers and single hyphens',
    );
    await expect(readFile(join(destination, 'package.json'), 'utf8')).rejects.toThrow();
  });

  test('ships one server-first theme implementation', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const webPackage = await readFile(
      join(templateRoot, 'packages/frontend/package.json'),
      'utf8',
    );
    const layout = await readFile(
      join(templateRoot, 'packages/frontend/src/app/[locale]/layout.tsx'),
      'utf8',
    );
    const transition = await readFile(
      join(templateRoot, 'packages/frontend/src/theme/transition.ts'),
      'utf8',
    );
    const globalStyles = await readFile(
      join(templateRoot, 'packages/frontend/src/app/globals.css'),
      'utf8',
    );

    expect(webPackage).toContain('"@wrksz/themes": "^1.1.0"');
    expect(webPackage).not.toContain(['next', 'themes'].join('-'));
    expect(layout).toContain("from '@wrksz/themes/next'");
    expect(transition).toContain('document.startViewTransition(updateTheme)');
    expect(transition).toContain('prefers-reduced-motion: reduce');
    expect(globalStyles).toContain('html[data-theme-transition="crossfade"]');
    expect(globalStyles).toContain('html[data-theme-transition="radial"]');
    expect(globalStyles).toStartWith('@import "tailwindcss";');
    expect(globalStyles).not.toContain('source(none)');
    expect(globalStyles).not.toContain('@source');
    await expect(
      readFile(join(templateRoot, 'packages/frontend/src/providers/theme.tsx'), 'utf8'),
    ).rejects.toThrow();
  });

  test('probes SEO transport once before browser-specific metadata checks', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const overlayRoot = join(import.meta.dir, '..', 'examples/repository');
    const neutralSmoke = await readFile(
      join(templateRoot, 'scripts/runtime-smoke.ts'),
      'utf8',
    );
    const repositorySmoke = await readFile(
      join(overlayRoot, 'scripts/runtime-smoke.ts'),
      'utf8',
    );
    const webProbe = await readFile(
      join(templateRoot, 'scripts/web-surface-smoke.ts'),
      'utf8',
    );
    const browserMetadata = await readFile(join(templateRoot, 'e2e/starter.spec.ts'), 'utf8');

    expect(neutralSmoke).toContain('assertPublicWebSurface');
    expect(repositorySmoke).toContain('assertPublicWebSurface');
    expect(webProbe).toContain('image/png');
    expect(webProbe).toContain("'/sitemap.xml'");
    expect(browserMetadata).toContain("'/api/og/en/themes'");
    expect(browserMetadata).not.toContain('request.get(');
  });

  test('runs PM2 apps from their own directories, with no launcher in between', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    for (const configName of ['ecosystem.dev.config.cjs', 'ecosystem.config.cjs']) {
      const file = await readFile(join(templateRoot, configName), 'utf8');
      // Assertions read the CODE, not the prose explaining it — the comments in
      // this generated file deliberately name the shape they rule out.
      const config = file
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      // Each role runs where it lives. A workspace filter would insert a
      // launcher process, and SIGTERM sent to a launcher never reaches the
      // role behind it — the drain simply would not run. Proved in the
      // template's own scripts/supervision-signal.test.ts.
      expect(config).toContain('cwd: path.join(__dirname, "packages/backend")');
      expect(config).toContain('cwd: path.join(__dirname, "packages/frontend")');
      expect(config).not.toContain('--filter');
      // And no launcher of any kind: a supervisor that starts a script runner
      // instead of the role makes the role receive the stop signal twice, and
      // the second press forces the shutdown before the declared drain runs.
      expect(config).not.toMatch(/args: \["run"/);

      // No binding value and no argv invented by the supervisor: the role
      // reads its port and interface from the environment inside its own
      // command, so a deployment only ever sets variables.
      expect(config).not.toContain('--port');
      expect(config).not.toContain('--hostname');
      expect(config).not.toContain('0.0.0.0');
      expect(config).not.toContain('127.0.0.1');

      expect(file).toStartWith('// GENERATED FILE — do not edit.');
    }

    expect(
      await readFile(join(templateRoot, 'packages/backend/src/index.ts'), 'utf8'),
    ).toContain('hostname: env.BIND_HOST');
  });

  test('every executable template TypeScript file is covered by its package tsconfig', async () => {
    // The compile gate is only as wide as the tsconfig `include` globs — a
    // config file outside them (the way `next.config.ts` once was) ships type
    // errors green. This walks the REAL template and proves total coverage.
    const templateRoot = join(import.meta.dir, '..', 'template');
    const globToRegex = (glob: string): RegExp => {
      // A bare directory include (`"src"`) covers everything under it.
      if (!glob.includes('*')) {
        return new RegExp(`^${glob.replaceAll('.', '\\.')}(/.*)?$`);
      }
      return new RegExp(
        `^${glob
          .replaceAll('.', '\\.')
          .replaceAll('**/', ' ')
          .replaceAll('*', '[^/]*')
          .replaceAll(' ', '(?:.*/)?')}$`,
      );
    };
    const readIncludes = async (dir: string): Promise<RegExp[]> => {
      const parsed = z
        .object({ include: z.array(z.string()) })
        .parse(JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8')));
      return parsed.include.flatMap((pattern) => {
        const patterns = [globToRegex(pattern)];
        // `src/**/*.ts` in tsconfig also matches `.tsx` only when listed —
        // keep the translation literal, no generosity.
        return patterns;
      });
    };
    const skip = new Set(['node_modules', 'dist', '.next', 'generated', 'migrations']);
    const listFiles = async (dir: string, relative: string): Promise<string[]> => {
      const entries = await readdir(join(dir, relative), { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (skip.has(entry.name) || entry.name === 'packages') continue;
          files.push(...(await listFiles(dir, entryPath)));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          files.push(entryPath);
        }
      }
      return files;
    };
    const roots = [
      templateRoot,
      ...(await readdir(join(templateRoot, 'packages'))).map((name) =>
        join(templateRoot, 'packages', name),
      ),
    ];
    const uncovered: string[] = [];
    for (const root of roots) {
      const includes = await readIncludes(root);
      for (const file of await listFiles(root, '')) {
        if (!includes.some((pattern) => pattern.test(file))) {
          uncovered.push(`${root.slice(templateRoot.length + 1) || '.'}/${file}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  test('uses an external PostgreSQL connection without shipping database containers', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const rootManifest = await readFile(join(templateRoot, 'package.json'), 'utf8');
    const developmentScript = await readFile(join(templateRoot, 'scripts/dev.ts'), 'utf8');
    const environment = await readFile(join(templateRoot, '_env.example'), 'utf8');

    expect(rootManifest).toContain('"db:setup": "bun run db:generate && bun run db:deploy"');
    // Development applies migrations through the DECLARED release step, the
    // same one production runs, so the two paths cannot drift on what
    // "up to date" means. The generated client stays a build artifact.
    expect(developmentScript).toContain("await run(['bun', 'run', 'db:generate']");
    expect(developmentScript).toContain('await runDeclaredReleaseSteps(environmentForRun)');
    const releaseScript = await readFile(
      join(templateRoot, 'scripts/release-steps.ts'),
      'utf8',
    );
    expect(releaseScript).toContain("prisma: ['bun', 'run', 'db:deploy']");
    expect(`${rootManifest}${developmentScript}${environment}`).not.toContain('docker');
    expect(environment).toContain('DATABASE_URL=postgresql://');
    expect(environment).not.toContain('COMPOSE_PROJECT_NAME');
    expect(environment).not.toContain('POSTGRES_PORT');
    await expect(readFile(join(templateRoot, 'compose.yaml'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(templateRoot, 'scripts/db-ensure.ts'), 'utf8'),
    ).rejects.toThrow();
  });

  test('copies the neutral template and materialises dotfiles', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const destination = join(await mkdtemp(join(tmpdir(), 'stitchkit-target-')), 'app');
    created.push(template, destination);
    await writeFile(join(template, 'package.json'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, 'project.json'),
      `${JSON.stringify(MINIMAL_DECLARATION, undefined, 2)}\n`,
    );
    await writeFile(join(template, 'bun.lock'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, '_env.example'),
      'DATABASE_URL=postgresql://db/stitchkit_starter\n',
    );
    await writeFile(join(template, '_gitignore'), 'node_modules\n');

    await scaffoldProject(template, destination);

    const manifest = await readFile(join(destination, 'package.json'), 'utf8');
    expect(manifest).toContain('"name": "app"');
    expect(await readFile(join(destination, 'bun.lock'), 'utf8')).toContain(
      '"name":"stitchkit-starter"',
    );
    expect(await readFile(join(destination, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  test('creates a project-specific local environment from the neutral example', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'talk-control');
    created.push(parent);

    await scaffoldProject(templateRoot, destination);
    // The scaffolder ships NO `.env` at all — `env:ensure` renders it from
    // `.env.example` with the destination identity on first run.
    expect(await Bun.file(join(destination, '.env')).exists()).toBe(false);
    const process = Bun.spawn(['bun', 'run', 'env:ensure'], {
      cwd: destination,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await process.exited).toBe(0);
    expect(await readFile(join(destination, '.env'), 'utf8')).toContain('/talk_control');
  });

  test('excludes local build and dependency artifacts from the generated project', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const destination = join(await mkdtemp(join(tmpdir(), 'stitchkit-target-')), 'app');
    created.push(template, destination);
    await writeFile(join(template, 'package.json'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, 'project.json'),
      `${JSON.stringify(MINIMAL_DECLARATION, undefined, 2)}\n`,
    );
    await writeFile(join(template, 'bun.lock'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, '_env.example'),
      'DATABASE_URL=postgresql://db/stitchkit_starter\n',
    );
    await mkdir(join(template, 'node_modules/react'), { recursive: true });
    await writeFile(
      join(template, 'node_modules/react/index.js'),
      'globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__',
    );
    await mkdir(join(template, 'packages/frontend/.next'), { recursive: true });
    await writeFile(join(template, 'packages/frontend/.next/build.js'), 'generated');
    await mkdir(join(template, 'packages/db/src/generated'), { recursive: true });
    await writeFile(join(template, 'packages/db/src/generated/client.ts'), 'generated');

    await scaffoldProject(template, destination);

    await expect(
      readFile(join(destination, 'node_modules/react/index.js'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(destination, 'packages/frontend/.next/build.js'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(destination, 'packages/db/src/generated/client.ts'), 'utf8'),
    ).rejects.toThrow();
  });

  test('excludes runtime artifacts from scaffold and package inputs', () => {
    expect(isTemplateSourcePathIncluded('test-results/.last-run.json')).toBeFalse();
    expect(isTemplateSourcePathIncluded('packages/frontend/.next/routes.json')).toBeFalse();
    expect(isTemplateSourcePathIncluded('packages/frontend/next-env.d.ts')).toBeFalse();
    expect(isTemplateSourcePathIncluded('packages/backend/dist/index.js')).toBeFalse();
    expect(isTemplateSourcePathIncluded('packages/db/src/generated/client.ts')).toBeFalse();
  });

  test('rejects a non-empty destination', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'occupied');
    await mkdir(destination);
    created.push(template, parent);
    await writeFile(join(destination, 'existing.txt'), 'occupied');

    await expect(scaffoldProject(template, destination)).rejects.toThrow(
      'Destination is not empty',
    );
  });

  test('cleans a newly created destination when materialisation fails', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const destination = join(parent, 'app');
    created.push(template, parent);
    await writeFile(join(template, 'target.txt'), 'target');
    await symlink(join(template, 'target.txt'), join(template, 'broken.txt'));

    await expect(scaffoldProject(template, destination)).rejects.toThrow(
      'Template entries must be files or directories',
    );
    await expect(readFile(join(destination, 'broken.txt'), 'utf8')).rejects.toThrow();
  });

  test('rejects a symbolic-link destination', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const parent = await mkdtemp(join(tmpdir(), 'stitchkit-target-'));
    const realDestination = join(parent, 'real');
    const destination = join(parent, 'linked');
    created.push(template, parent);
    await symlink(realDestination, destination);

    await expect(scaffoldProject(template, destination)).rejects.toThrow(
      'Destination cannot be a symbolic link',
    );
  });
});
