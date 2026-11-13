import path from 'path';
import { defineConfig } from '@playwright/test';

// Static files only. The spec mocks /api and the run socket; nothing here
// reaches githack or the live site.
const web = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: __dirname,
  outputDir: path.resolve(__dirname, '../../../test-results'),
  timeout: 900_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    cwd: web,
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
