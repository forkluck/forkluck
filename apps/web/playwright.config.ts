import { defineConfig, devices } from "@playwright/test"

function port(name: string, fallback: string) {
  const value = process.env[name] ?? fallback
  if (!/^\d{2,5}$/.test(value)) throw new Error(`${name} must be a valid port`)
  return value
}

process.env.FORKLUCK_ACCEPTANCE_GUEST_TOKEN ??= "acceptance-guest-token"

const nextPort = port("FORKLUCK_ACCEPTANCE_NEXT_PORT", "3100")
const backendPort = port("FORKLUCK_ACCEPTANCE_BACKEND_PORT", "8101")
const connectorPort = port("FORKLUCK_ACCEPTANCE_CONNECTOR_PORT", "9123")
const baseURL = `http://127.0.0.1:${nextPort}`
const backendURL = `http://127.0.0.1:${backendPort}`
const connectorURL = `http://127.0.0.1:${connectorPort}`

export default defineConfig({
  testDir: "./tests/acceptance",
  outputDir: "output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "output/playwright/report" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      name: "synthetic HTTP connector service",
      command:
        "../api/.venv/bin/python ../api/manage.py run_fake_connector_service --host 127.0.0.1 --port $FORKLUCK_ACCEPTANCE_CONNECTOR_PORT --client-id public-app --client-secret public-secret --failures ack_once",
      url: `${connectorURL}/healthz`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        FORKLUCK_ACCEPTANCE_CONNECTOR_PORT: connectorPort,
      },
    },
    {
      name: "synthetic Django acceptance backend",
      command: "node scripts/start-acceptance-backend.mjs",
      url: `${backendURL}/api/auth/csrf`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        FORKLUCK_ACCEPTANCE_BACKEND_PORT: backendPort,
        FORKLUCK_ACCEPTANCE_CONNECTOR_PORT: connectorPort,
        FORKLUCK_ACCEPTANCE_NEXT_PORT: nextPort,
        FORKLUCK_CONNECTOR_CLIENT_ID: "public-app",
        FORKLUCK_CONNECTOR_CLIENT_SECRET: "public-secret",
        FORKLUCK_CONNECTOR_SERVICE_URL: connectorURL,
      },
    },
    {
      name: "Next.js acceptance frontend",
      command: "node scripts/start-acceptance-next.mjs",
      url: baseURL,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        DJANGO_INTERNAL_ORIGIN: backendURL,
        DJANGO_PUBLIC_ORIGIN: backendURL,
        FORKLUCK_ACCEPTANCE_BACKEND_PORT: backendPort,
        FORKLUCK_ACCEPTANCE_NEXT_PORT: nextPort,
        FORKLUCK_INTERNAL_SECRET: "synthetic-acceptance-internal-secret",
        FORKLUCK_NEXT_DIST_DIR: ".next-acceptance",
        // Only the address the merchant shares with; no key, so nothing in
        // the acceptance run can reach Google.
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "acceptance-drive@example.test",
        NEXT_TELEMETRY_DISABLED: "1",
        // Enable Primo without allowing acceptance runs to use real inference or blob credentials.
        QWEN_API_KEY: "synthetic-acceptance-only",
        QWEN_BASE_URL: "https://primo.example.invalid/v1",
        AZURE_STORAGE_CONNECTION_STRING: "",
        DOCUMENT_STORE_DIR: "./.forkluck/acceptance-documents",
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      // Never the server's zone, so an unpinned formatter shows up as a mismatch.
      use: { ...devices["Desktop Chrome"], timezoneId: "Pacific/Kiritimati" },
    },
  ],
})
