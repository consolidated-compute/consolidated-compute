import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:43131",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 43131 --strictPort",
    url: "http://127.0.0.1:43131/docs/capabilities",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
