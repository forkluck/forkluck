import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The wait after a press belongs to the control that was pressed
 * (AGENTS.md "Feedback"). Two ways of losing it are cheap to type and
 * invisible in review, so they are pinned here: a bare `router.refresh()`,
 * whose round trip nothing tracks, and a `useTransition()` whose `isPending`
 * is thrown away.
 */
const REFRESH_HOME = "hooks/use-refresh.ts"

const BARE_REFRESH = /\brouter\.refresh\(\)/
const DISCARDED_PENDING =
  /const \[\s*,\s*\w+\s*\]\s*=\s*(React\.)?useTransition\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    )
    .map((entry) => join(entry.parentPath, entry.name))
}

function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of [
    ...sourceFiles("app"),
    ...sourceFiles("components"),
    ...sourceFiles("hooks"),
  ]) {
    if (file === REFRESH_HOME) continue
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (pattern.test(line)) found.push(`${file}:${index + 1}`)
      })
  }
  return found
}

describe("feedback", () => {
  it("routes every router.refresh() through useRefresh", () => {
    expect(
      offenders(BARE_REFRESH),
      "call refresh() from useRefresh so the wait covers the re-render"
    ).toEqual([])
  })

  it("keeps every transition's isPending", () => {
    expect(
      offenders(DISCARDED_PENDING),
      "read isPending and put it on the control that started the transition"
    ).toEqual([])
  })
})
