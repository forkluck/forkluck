#!/usr/bin/env node
// One command to make the supplier connector service part of a local
// Forkluck: prepare the service's checkout, register the app with it, and
// write the app's three connector settings. Re-running is safe; it rotates
// the client secret and keeps the encryption key.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = fileURLToPath(new URL("../", import.meta.url))
const connectors = path.join(root, "services", "connectors")
const python = path.join(connectors, ".venv", "bin", "python")
const apiEnv = path.join(root, "apps", "api", ".env")
const apiEnvExample = path.join(root, "apps", "api", ".env.example")

if (!existsSync(python)) {
  console.error(
    "services/connectors/.venv is missing. Create it first:\n" +
      "  cd services/connectors && python3.13 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt"
  )
  process.exit(1)
}

if (!existsSync(apiEnv)) copyFileSync(apiEnvExample, apiEnv)

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#") && line.includes("="))
      .map((line) => line.split("=", 2).map((part) => part.trim()))
  )

// The callback the API sends the connector service must match the API's own
// origin, so the registration follows apps/api/.env rather than a guess.
const appOrigin = readEnv(apiEnv).FORKLUCK_APP_ORIGIN || "http://localhost:3000"

const result = spawnSync(
  python,
  [path.join(connectors, "manage.py"), "bootstrap_local", "--app-origin", appOrigin],
  { cwd: connectors, encoding: "utf8" }
)
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const settings = {}
for (const line of result.stdout.split("\n")) {
  const match = line.match(/^(FORKLUCK_CONNECTOR_[A-Z_]+)=(.*)$/)
  if (match) settings[match[1]] = match[2]
  else if (line.trim()) console.log(line)
}
const expected = [
  "FORKLUCK_CONNECTOR_SERVICE_URL",
  "FORKLUCK_CONNECTOR_CLIENT_ID",
  "FORKLUCK_CONNECTOR_CLIENT_SECRET",
]
if (expected.some((key) => !(key in settings))) {
  console.error("bootstrap_local did not print the three connector settings")
  process.exit(1)
}

// Replace each setting's line in apps/api/.env, appending any that is absent.
let lines = readFileSync(apiEnv, "utf8").split("\n")
for (const key of expected) {
  const index = lines.findIndex((line) => line.split("=", 1)[0].trim() === key)
  const entry = `${key}=${settings[key]}`
  if (index === -1) lines.push(entry)
  else lines[index] = entry
}
writeFileSync(apiEnv, lines.join("\n").replace(/\n*$/, "\n"))

console.log(
  expected.map((key) => `${key}=${settings[key]}`).join("\n") +
    "\n\nWritten to apps/api/.env. Restart `pnpm backend:dev`, then start\n" +
    "`pnpm connectors:dev`, `pnpm connectors:worker` and `pnpm backend:connector-worker`."
)
