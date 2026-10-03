import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Synthetic package tests receiver preservation and exact package admission, not platform paths. */
export async function browserRuntimeFixture(
  root: string,
  headlessName = 'chromium',
): Promise<{ packageRoot: string }> {
  const packageRoot = join(root, 'project');
  const testModule = join(packageRoot, 'node_modules/@playwright/test');
  const playwrightModule = join(testModule, 'node_modules/playwright');
  const module = join(playwrightModule, 'node_modules/playwright-core');
  await mkdir(module, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      overrides: { 'playwright-core': '1.63.0' },
    }),
  );
  await writeFile(
    join(testModule, 'package.json'),
    JSON.stringify({
      name: '@playwright/test',
      version: '1.63.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  await writeFile(join(testModule, 'index.js'), "export * from 'playwright';\n");
  await writeFile(
    join(playwrightModule, 'package.json'),
    JSON.stringify({
      name: 'playwright',
      version: '1.63.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  await writeFile(join(playwrightModule, 'index.js'), "export * from 'playwright-core';\n");
  await writeFile(
    join(module, 'package.json'),
    JSON.stringify({
      name: 'playwright-core',
      version: '1.63.0',
      type: 'module',
      exports: {
        '.': './index.js',
        './package.json': './package.json',
        './lib/coreBundle': './coreBundle.js',
      },
    }),
  );
  await writeFile(
    join(module, 'index.js'),
    `
    class BrowserType {
      constructor(name) { this.name = name; }
      executablePath() { return process.env.PLAYWRIGHT_BROWSERS_PATH + '/' + this.name; }
    }
    export const chromium = new BrowserType('chromium');
    export const webkit = new BrowserType('webkit');
  `,
  );
  await writeFile(
    join(module, 'coreBundle.js'),
    `
    class Registry {
      constructor() { this.names = {'chromium-headless-shell': ${JSON.stringify(headlessName)}, webkit: 'webkit'}; }
      findExecutable(name) {
        const executable = this.names[name];
        if (!executable) return undefined;
        return { executablePath() { return process.env.PLAYWRIGHT_BROWSERS_PATH + '/' + executable; } };
      }
    }
    export const registry = {registry: new Registry()};
  `,
  );
  return { packageRoot };
}
