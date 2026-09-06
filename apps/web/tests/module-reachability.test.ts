import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/**
 * `components/`, `hooks/` and `lib/` are composition only: every module there
 * exists to be pulled into a route, a component, or another module. A file
 * nobody imports is unreachable — it can never run, and it silently rots
 * against the types it was written for. Three such modules survived refactors
 * before this guard covered `components/` and `hooks/`, and two backend
 * loaders under `lib/backend/` survived the recipe-page rewrite that dropped
 * their only importer before it covered `lib/`.
 */
const ORPHAN_ROOTS = ["components", "hooks", "lib"]
const SOURCE_ROOTS = ["app", "components", "hooks", "lib", "scripts", "tests"]
const ENTRYPOINT_FILES = ["next.config.ts"]
const CODE_EXTENSIONS = [".ts", ".tsx", ".mjs"]

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return []
      return walk(absolute)
    }
    return CODE_EXTENSIONS.includes(path.extname(entry.name)) ? [absolute] : []
  })
}

const sourceFiles = [
  ...SOURCE_ROOTS.flatMap((root) => walk(path.join(repositoryRoot, root))),
  ...ENTRYPOINT_FILES.map((file) => path.join(repositoryRoot, file)).filter(
    (file) => fs.existsSync(file)
  ),
]

/** Static `from "…"`, bare `import "…"`, and literal `import("…")` alike. */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g

/** Candidate on-disk paths a specifier could resolve to, extensionless. */
function resolveCandidates(specifier: string, importer: string): string[] {
  let base: string
  if (specifier.startsWith("@/")) {
    base = path.join(repositoryRoot, specifier.slice(2))
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importer), specifier)
  } else {
    return []
  }
  return [
    base,
    ...CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...CODE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ]
}

const importedPaths = new Set<string>()
for (const file of sourceFiles) {
  const contents = fs.readFileSync(file, "utf8")
  for (const match of contents.matchAll(SPECIFIER_PATTERN)) {
    for (const candidate of resolveCandidates(match[1], file)) {
      // A module that only imports itself is still unreachable.
      if (candidate !== file) importedPaths.add(candidate)
    }
  }
}

describe("module reachability", () => {
  it("finds modules to check", () => {
    expect(
      ORPHAN_ROOTS.flatMap((root) => walk(path.join(repositoryRoot, root)))
        .length
    ).toBeGreaterThan(50)
  })

  it("has an importer for every module under components/, hooks/ and lib/", () => {
    const orphans = ORPHAN_ROOTS.flatMap((root) =>
      walk(path.join(repositoryRoot, root))
    )
      .filter((file) => !/\.test\.tsx?$/.test(file))
      // Ambient declarations are picked up by tsconfig, never imported.
      .filter((file) => !file.endsWith(".d.ts"))
      .filter((file) => !importedPaths.has(file))
      .map((file) => path.relative(repositoryRoot, file))
      .sort()

    expect(orphans).toEqual([])
  })
})
