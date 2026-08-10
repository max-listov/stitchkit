import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTemplateSourcePathIncluded, scaffoldProject } from '../src/scaffold';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
    const environment = await readFile(join(destination, '.env'), 'utf8');
    expect(environment).toContain('CORS_ORIGIN=*');
    expect(environment).toContain('GITHUB_REPOSITORY=max-listov/stitchkit');
    const serverConfig = await readFile(
      join(destination, 'packages/config/src/server.ts'),
      'utf8',
    );
    expect(serverConfig).toContain('DEV_HTTPS_CERT');
    expect(serverConfig).toContain('featureServerSchema');
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

    expect(JSON.parse(await readFile(join(destination, 'app.config.json'), 'utf8'))).toEqual({
      slug: 'talk-control',
      name: 'Talk Control Console',
      version: '0.1.0',
      description: {
        en: 'Talk Control Console is a production application built with Stitchkit.',
        ru: 'Talk Control Console — production-приложение на Stitchkit.',
      },
    });
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
      expect(guidance).not.toMatch(/Capetown|Gecko|ML Stack|\/home\/|\/Users\//i);
      expect(guidance).not.toContain('npm publish');
      expect(guidance).not.toContain('git tag');
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

  test('runs PM2 apps from their package directories', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    for (const configName of ['ecosystem.dev.config.cjs', 'ecosystem.config.cjs']) {
      const config = await readFile(join(templateRoot, configName), 'utf8');
      expect(config).toContain("cwd: path.join(__dirname, 'packages/backend')");
      expect(config).toContain("cwd: path.join(__dirname, 'packages/frontend')");
      expect(config).not.toContain('cwd: __dirname');
      expect(config).not.toContain('--filter @app/');
      expect(config).not.toContain("script: 'bun'");
      expect(config).not.toContain("args: 'run ");
    }

    const developmentConfig = await readFile(
      join(templateRoot, 'ecosystem.dev.config.cjs'),
      'utf8',
    );
    expect(developmentConfig).toContain("script: 'src/index.ts'");
    expect(developmentConfig).toContain("interpreter_args: '--watch'");
    expect(developmentConfig).toContain("script: 'node_modules/.bin/next'");
    expect(developmentConfig).toContain(
      "const frontendArgs = ['dev', '--port', process.env.WEB_PORT",
    );
    expect(developmentConfig).toContain('args: frontendArgs');
    expect(developmentConfig.match(/autorestart: true/g)).toHaveLength(2);
  });

  test('uses an external PostgreSQL connection without shipping database containers', async () => {
    const templateRoot = join(import.meta.dir, '..', 'template');
    const rootManifest = await readFile(join(templateRoot, 'package.json'), 'utf8');
    const developmentScript = await readFile(join(templateRoot, 'scripts/dev.ts'), 'utf8');
    const environment = await readFile(join(templateRoot, '_env'), 'utf8');

    expect(rootManifest).toContain('"db:setup": "bun run db:generate && bun run db:deploy"');
    expect(developmentScript).toContain("await run(['bun', 'run', 'db:setup']");
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
    await writeFile(join(template, 'bun.lock'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, '_env'),
      'DATABASE_URL=postgresql://db/stitchkit_starter\n',
    );
    await writeFile(
      join(template, '_env.example'),
      'DATABASE_URL=postgresql://db/stitchkit_starter\n',
    );
    await writeFile(join(template, '_gitignore'), 'node_modules\n');

    await scaffoldProject(template, destination);

    const manifest = await readFile(join(destination, 'package.json'), 'utf8');
    expect(manifest).toContain('"name": "app"');
    expect(await readFile(join(destination, 'bun.lock'), 'utf8')).toContain('"name": "app"');
    expect(await readFile(join(destination, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  test('excludes local build and dependency artifacts from the generated project', async () => {
    const template = await mkdtemp(join(tmpdir(), 'stitchkit-template-'));
    const destination = join(await mkdtemp(join(tmpdir(), 'stitchkit-target-')), 'app');
    created.push(template, destination);
    await writeFile(join(template, 'package.json'), '{"name":"stitchkit-starter"}\n');
    await writeFile(join(template, 'bun.lock'), '{"name":"stitchkit-starter"}\n');
    await writeFile(
      join(template, '_env'),
      'DATABASE_URL=postgresql://db/stitchkit_starter\n',
    );
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
