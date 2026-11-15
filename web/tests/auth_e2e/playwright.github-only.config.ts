import path from 'path';
import { defineConfig } from '@playwright/test';

const port = process.env.AUTH_E2E_PORT || '18942';
const web = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: __dirname,
  testMatch: 'github_only.spec.ts',
  outputDir: '/tmp/esp32lab-pw-auth-github',
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
      args: [`--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:${port}`],
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
      AUTH_E2E_HOST: '127.0.0.1',
      AUTH_E2E_HTTPS: '0',
      AUTH_E2E_IP: '0',
      AUTH_ENABLED: '1',
      AUTH_GOOGLE: '0',
      AUTH_GITHUB: '1',
      AUTH_E2E_INFO: '/tmp/esp32lab-auth-e2e-github.json',
      SIM_PREWARM: '0',
      SIM_NETSTACK_WARM: '0',
    },
  },
});
