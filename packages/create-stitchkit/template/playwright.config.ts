import { defineConfig, devices } from '@playwright/test';
import { loadToolingEnv } from './scripts/tooling-env';

const toolingEnv = loadToolingEnv();
const baseURL = toolingEnv.PLAYWRIGHT_BASE_URL ?? toolingEnv.SMOKE_WEB_ORIGIN;

export default defineConfig({
  testDir: './e2e',
  retries: 0,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
