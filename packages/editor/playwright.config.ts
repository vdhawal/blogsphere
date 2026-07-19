import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Smoke-test config. Spins up a dedicated server + Vite on isolated ports
 * (4327/4328) pointing at a fresh temp workspace, so it never collides with
 * a developer's running `npm run dev:*` on 4317/4318.
 *
 * The temp workspace is created here at config-load time and reused by both
 * webServer commands via env vars. Each test run gets a fresh directory;
 * old ones live in $TMPDIR until the OS cleans them up.
 */
const WORKSPACE = mkdtempSync(join(tmpdir(), "blogspace-e2e-"));
const API_PORT = "4327";
const EDITOR_PORT = "4328";

// Surface the path so a failing run is easy to inspect.
console.log(`e2e workspace: ${WORKSPACE}`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${EDITOR_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 8_000,
  },
  webServer: [
    {
      command: `BLOGSPACE_WORKSPACE=${WORKSPACE} PORT=${API_PORT} npx tsx ../server/src/index.ts`,
      url: `http://127.0.0.1:${API_PORT}/api/workspace`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `BLOGSPACE_API_PORT=${API_PORT} BLOGSPACE_EDITOR_PORT=${EDITOR_PORT} npx vite --port ${EDITOR_PORT} --host 127.0.0.1`,
      url: `http://127.0.0.1:${EDITOR_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
