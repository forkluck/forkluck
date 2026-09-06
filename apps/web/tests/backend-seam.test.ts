import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * `lib/backend/` is the only seam to Django (AGENTS.md, ARCHITECTURE.md).
 *
 * The rule is not that other modules may never trigger a backend call —
 * `"use server"` actions call `djangoAction(slug, body)` by design, and that
 * is documented. The rule is that no module outside the seam may know the
 * *wire*: the `/internal/v1/` route it hits, the origin it dials, or the
 * shared secret it must present. Every one of those lives behind a named
 * function in `lib/backend/queries.ts`, so the route table, the payload type,
 * and the drift alarm move together in one place.
 *
 * This is the frontend counterpart of import-linter: a scan, because TypeScript
 * cannot express "this string literal belongs to that directory".
 */

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
)
const SEAM = path.join("lib", "backend")

/** Source roots that ship in the Next build. */
const SOURCE_ROOTS = ["app", "components", "hooks", "lib"]

/**
 * Wire knowledge, in every form a module could spell it. A path built as
 * `` `/internal/v1/${x}/` `` still contains the prefix, so matching the prefix
 * covers string literals and template literals alike.
 */
const WIRE_MARKERS = [
  "/internal/v1",
  "DJANGO_INTERNAL_ORIGIN",
  "FORKLUCK_INTERNAL_SECRET",
  "X-Forkluck-Internal-Secret",
]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    found.push(full)
  }
  return found
}

function shippedSources(): string[] {
  return SOURCE_ROOTS.flatMap((root) =>
    sourceFiles(path.join(repositoryRoot, root))
  )
}

describe("the Django seam", () => {
  it("scans a source tree that is actually there", () => {
    // A typo in SOURCE_ROOTS would make every assertion below vacuous.
    const files = shippedSources()
    expect(files.length).toBeGreaterThan(50)
    expect(
      files.filter((file) => file.includes(SEAM)).length
    ).toBeGreaterThanOrEqual(5)
  })

  it.each(WIRE_MARKERS)(
    "keeps %s out of every module outside lib/backend/",
    (marker) => {
      const offenders = shippedSources()
        .filter((file) => !file.includes(SEAM))
        .filter((file) => readFileSync(file, "utf8").includes(marker))
        .map((file) => path.relative(repositoryRoot, file))

      expect(offenders).toEqual([])
    }
  )

  it.each(WIRE_MARKERS)(
    "still uses %s somewhere inside lib/backend/",
    (marker) => {
      // Guards against the inverse failure: the assertion above also passes if
      // the seam quietly stopped speaking to Django at all.
      const users = shippedSources()
        .filter((file) => file.includes(SEAM))
        .filter((file) => readFileSync(file, "utf8").includes(marker))

      expect(users.length).toBeGreaterThan(0)
    }
  )

  it("routes every backend request through client.ts", () => {
    // ARCHITECTURE.md: "lib/backend/client.ts is the only code that speaks to
    // /internal/v1/". Sibling modules in the seam compose paths; they must not
    // dial out themselves, or the cookie forwarding, the internal secret, and
    // the 401 -> BackendUnauthorizedError mapping would each have a second,
    // unguarded implementation.
    const offenders = shippedSources()
      .filter((file) => file.includes(SEAM))
      .filter((file) => path.basename(file) !== "client.ts")
      .filter((file) => /\bfetch\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repositoryRoot, file))

    expect(offenders).toEqual([])
  })
})
