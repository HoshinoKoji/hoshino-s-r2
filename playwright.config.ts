import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:8790', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // A synthetic fixture keeps browser checks independent of fork deployment settings.
    command: 'node scripts/wrangler.mjs dev --override tests/fixtures/deploy.toml --port 8790',
    url: 'http://127.0.0.1:8790/api/v1/buckets',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
