import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { sourceFiles } from "./source-files"

describe("public kitchen core boundaries", () => {
  it("keeps kitchen tools, drafts and WebMCP independent of Primo and model SDKs", () => {
    const files = [
      ...sourceFiles(resolve("lib/kitchen-tools")),
      resolve("lib/recipe/draft.ts"),
      resolve("components/kitchen-tools-webmcp.tsx"),
    ]
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/from ["'][^"']*primo[^"']*["']/)
      expect(source, file).not.toMatch(/from ["'](?:ai|@ai-sdk\/[^"']+)["']/)
    }
  })

  it("keeps request-bound execution out of the client entry point and shared schemas", () => {
    expect(
      readFileSync(resolve("lib/kitchen-tools/server.ts"), "utf8")
    ).toContain('import "server-only"')
    for (const file of ["client.ts", "catalog.ts", "results.ts"]) {
      expect(
        readFileSync(resolve("lib/kitchen-tools", file), "utf8"),
        file
      ).not.toMatch(/from ["'](?:next\/headers|[^"']*\/server)["']/)
    }
  })
})
