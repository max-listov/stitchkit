import { defineConfig, devices } from '@playwright/test';
import { toolingEnv } from './scripts/tooling-env';

const baseURL = toolingEnv.PLAYWRIGHT_BASE_URL ?? toolingEnv.NEXT_PUBLIC_WEB_URL;

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
