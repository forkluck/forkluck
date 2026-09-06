#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const nextPort = process.env.FORKLUCK_ACCEPTANCE_NEXT_PORT ?? "3100"
const backendPort = process.env.FORKLUCK_ACCEPTANCE_BACKEND_PORT ?? "8101"

for (const [name, value] of [
  ["FORKLUCK_ACCEPTANCE_NEXT_PORT", nextPort],
  ["FORKLUCK_ACCEPTANCE_BACKEND_PORT", backendPort],
]) {
  if (!/^\d{2,5}$/.test(value)) throw new Error(`${name} must be a valid port`)
}

const environment = {
  ...process.env,
  FORKLUCK_NEXT_DIST_DIR:
    process.env.FORKLUCK_NEXT_DIST_DIR ?? ".next-acceptance",
  NEXT_TELEMETRY_DISABLED: "1",
}

const build = spawnSync("pnpm", ["exec", "next", "build"], {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
})
if (build.status !== 0) process.exit(build.status ?? 1)

const distDirectory = environment.FORKLUCK_NEXT_DIST_DIR
// Next traces the standalone build from the nearest lockfile above the
// project. A git worktree inside the main checkout is traced from that
// checkout, so its server lands under standalone/<path of the worktree>.
function standaloneRootFor(outputDirectory) {
  if (existsSync(path.join(outputDirectory, "server.js"))) return outputDirectory
  let ancestor = path.dirname(repositoryRoot)
  while (ancestor !== path.dirname(ancestor)) {
    if (existsSync(path.join(ancestor, "pnpm-lock.yaml"))) {
      const nested = path.join(
        outputDirectory,
        path.relative(ancestor, repositoryRoot)
      )
      if (existsSync(path.join(nested, "server.js"))) return nested
    }
    ancestor = path.dirname(ancestor)
  }
  return outputDirectory
}
const standaloneRoot = standaloneRootFor(
  path.join(repositoryRoot, distDirectory, "standalone")
)
const standaloneServer = path.join(standaloneRoot, "server.js")

// Standalone output intentionally omits CDN-managed assets. The acceptance
// server is self-contained, so copy both asset trees exactly as Next documents.
cpSync(
  path.join(repositoryRoot, "public"),
  path.join(standaloneRoot, "public"),
  {
    recursive: true,
  }
)
cpSync(
  path.join(repositoryRoot, distDirectory, "static"),
  path.join(standaloneRoot, distDirectory, "static"),
  { recursive: true }
)

const server = spawn(process.execPath, [standaloneServer], {
  cwd: standaloneRoot,
  env: {
    ...environment,
    HOSTNAME: "127.0.0.1",
    PORT: nextPort,
  },
  stdio: "inherit",
})

let stopping = false
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true
    server.kill(signal)
  })
}

server.on("error", (error) => {
  console.error(error)
  process.exit(1)
})

server.on("exit", (code) => {
  process.exit(stopping ? 0 : (code ?? 1))
})
