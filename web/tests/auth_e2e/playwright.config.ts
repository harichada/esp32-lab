import path from 'path';
import { defineConfig } from '@playwright/test';

const port = process.env.AUTH_E2E_PORT || '18941';
const web = path.resolve(__dirname, '../..');
const origins = `http://127.0.0.1:${port},http://localhost:${port}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: 'auth.spec.ts',
  outputDir: '/tmp/esp32lab-pw-auth',
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
    launchOptions: {
      args: [`--unsafely-treat-insecure-origin-as-secure=${origins}`],
    },
  },
  webServer: {
    command: 'bash tests/auth_e2e/serve.sh',
    cwd: web,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      AUTH_E2E_PORT: port,
      AUTH_E2E_HOST: 'localhost',
      AUTH_E2E_HTTPS: '0',
      AUTH_E2E_IP: '0',
      AUTH_GOOGLE: '1',
      AUTH_GITHUB: '1',
      AUTH_E2E_INFO: '/tmp/esp32lab-auth-e2e.json',
      SIM_PREWARM: '0',
      SIM_NETSTACK_WARM: '0',
    },
  },
});
