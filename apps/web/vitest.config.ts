import path from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": repositoryRoot,
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup/web-storage.ts"],
    exclude: [
      ".claude/**",
      "node_modules/**",
      ".next/**",
      ".next-acceptance/**",
      "tests/acceptance/**",
    ],
    restoreMocks: true,
    // One retry in CI only: a deploy should not die on a timing flake.
    retry: process.env.CI ? 1 : 0,
  },
})
