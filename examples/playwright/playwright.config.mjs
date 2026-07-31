import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";

const jsonOutput = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const outputDir = jsonOutput
  ? join(dirname(jsonOutput), "test-results")
  : "test-results";

export default defineConfig({
  testDir: "./tests",
  retries: 0,
  workers: 1,
  outputDir,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
