import path from 'path';
import { defineConfig } from '@playwright/test';

const port = process.env.MIGRATE_E2E_PORT || '18931';
const web = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: __dirname,
  testMatch: 'migrate.spec.ts',
  outputDir: '/tmp/esp32lab-pw-migrate',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'python3 tests/migrate_e2e/move_server.py',
    cwd: web,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...process.env, MIGRATE_E2E_PORT: port, SIM_PREWARM: '0', SIM_NETSTACK_WARM: '0' },
  },
});
