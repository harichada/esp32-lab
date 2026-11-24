import path from 'path';
import { defineConfig } from '@playwright/test';

const port = process.env.AUTH_EMAIL_E2E_PORT || '18943';
const python = process.env.PLAYWRIGHT_PYTHON || 'python3';

export default defineConfig({
  testDir: __dirname,
  testMatch: 'email.spec.ts',
  outputDir: path.resolve(__dirname, '../../../test-results/email-api'),
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || (process.env.CI ? 'chromium' : 'chrome'),
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: `${python} "${path.join(__dirname, 'email_server.py')}"`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30000,
    env: { AUTH_EMAIL_E2E_PORT: port },
  },
});
