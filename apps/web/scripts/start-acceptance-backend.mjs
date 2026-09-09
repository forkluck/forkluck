#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const apiRoot = fileURLToPath(new URL("../../api/", import.meta.url))
const localPython = path.join(apiRoot, ".venv", "bin", "python")
const python =
  process.env.FORKLUCK_ACCEPTANCE_PYTHON ||
  (existsSync(localPython) ? localPython : "python3")
const manage = path.join(apiRoot, "manage.py")
const port = process.env.FORKLUCK_ACCEPTANCE_BACKEND_PORT ?? "8101"

if (!/^\d{2,5}$/.test(port)) {
  throw new Error("FORKLUCK_ACCEPTANCE_BACKEND_PORT must be a valid port")
}

const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), "forkluck-acceptance-")
)
const databasePath = path.join(temporaryDirectory, "db.sqlite3")
const environment = {
  ...process.env,
  DATABASE_URL: "",
  DJANGO_ALLOWED_HOSTS: "127.0.0.1,localhost",
  DJANGO_CSRF_TRUSTED_ORIGINS: `http://127.0.0.1:${process.env.FORKLUCK_ACCEPTANCE_NEXT_PORT ?? "3100"}`,
  DJANGO_SECRET_KEY: "synthetic-acceptance-only",
  DJANGO_SETTINGS_MODULE: "config.settings_acceptance",
  FORKLUCK_ACCEPTANCE: "1",
  FORKLUCK_ACCEPTANCE_DB: databasePath,
  FORKLUCK_ALLOW_DEMO_ACCOUNT: "1",
  FORKLUCK_APP_ORIGIN: `http://127.0.0.1:${process.env.FORKLUCK_ACCEPTANCE_NEXT_PORT ?? "3100"}`,
  FORKLUCK_ENVIRONMENT: "test",
  FORKLUCK_INTERNAL_SECRET: "synthetic-acceptance-internal-secret",
  GOOGLE_SIGN_IN_CLIENT_ID: "synthetic-google-client",
  GOOGLE_SIGN_IN_CLIENT_SECRET: "synthetic-google-secret",
}

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  rmSync(temporaryDirectory, { force: true, recursive: true })
}

process.on("exit", cleanup)

function manageCommand(args) {
  const result = spawnSync(python, [manage, ...args], {
    cwd: apiRoot,
    env: environment,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    cleanup()
    process.exit(result.status ?? 1)
  }
}

manageCommand(["migrate", "--noinput"])
manageCommand([
  "seed_demo_data",
  "--email",
  "playwright@example.test",
  "--password",
  "Synthetic acceptance 2026!",
])

const server = spawn(
  python,
  [manage, "runserver", `127.0.0.1:${port}`, "--noreload"],
  {
    cwd: apiRoot,
    env: environment,
    stdio: "inherit",
  }
)

// The browser flow only enqueues a durable connector run. Keep a real worker
// beside the acceptance backend so Playwright exercises the service boundary,
// importer, acknowledgement retry, and resulting invoice instead of calling
// the domain function in-process from a test.
const connectorWorker = spawn(
  python,
  [manage, "run_connector_sync_worker", "--poll-interval", "0.2"],
  {
    cwd: apiRoot,
    env: environment,
    stdio: "inherit",
  }
)

let stopping = false
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true
    server.kill(signal)
    connectorWorker.kill(signal)
  })
}

server.on("error", (error) => {
  console.error(error)
  cleanup()
  process.exit(1)
})

server.on("exit", (code) => {
  connectorWorker.kill("SIGTERM")
  cleanup()
  process.exit(stopping ? 0 : (code ?? 1))
})

connectorWorker.on("error", (error) => {
  console.error(error)
  server.kill("SIGTERM")
  cleanup()
  process.exit(1)
})

connectorWorker.on("exit", (code) => {
  if (stopping) return
  console.error(`Connector acceptance worker stopped unexpectedly (${code})`)
  server.kill("SIGTERM")
  cleanup()
  process.exit(code ?? 1)
})
