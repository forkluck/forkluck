import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { sourceFiles } from "./source-files"

/**
 * The wait after a press belongs to the control that was pressed
 * (AGENTS.md "Feedback"). Three ways of losing it are cheap to type and
 * invisible in review, so they are pinned here: a bare `router.refresh()`,
 * whose round trip nothing tracks; a `useTransition()` whose `isPending`
 * is thrown away; and a bare `router.push()` or `router.replace()`, whose
 * wait never reaches the shell that dims the page.
 */
const REFRESH_HOME = "hooks/use-refresh.ts"
/** Where navigation lives: GuardedLink and useGuardedNavigate. */
const NAVIGATION_HOME = "components/navigation-blocker.tsx"
/** Search-param transitions with a LoadingRegion of their own. */
const BROWSE_HOME = "hooks/use-browse-url.ts"

const BARE_REFRESH = /\brouter\.refresh\(\)/
const DISCARDED_PENDING =
  /const \[\s*,\s*\w+\s*\]\s*=\s*(React\.)?useTransition\(/
const BARE_NAVIGATION = /\brouter\.(push|replace)\(/
/** A push or replace carried by a transition of its own, on this or the
 *  line before: a filter or tab that dims the region it replaces. */
const CARRIED = /\bstart\w*\(\(\) =>/

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

/**
 * Every navigation reports to the shell: through a GuardedLink, through
 * useGuardedNavigate, or inside a transition whose pending the screen shows
 * itself. The auth screens sit outside the shell and are left alone.
 */
function bareNavigations(): string[] {
  const found: string[] = []
  for (const file of [
    ...sourceFiles("app/(app)"),
    ...sourceFiles("components"),
    ...sourceFiles("hooks"),
  ]) {
    if (
      file === NAVIGATION_HOME ||
      file === BROWSE_HOME ||
      file.startsWith("components/auth/")
    )
      continue
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      if (!BARE_NAVIGATION.test(line)) return
      if (CARRIED.test(line) || CARRIED.test(lines[index - 1] ?? "")) return
      found.push(`${file}:${index + 1}`)
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

  it("routes every navigation through the shell's pending signal", () => {
    expect(
      bareNavigations(),
      "navigate with GuardedLink or useGuardedNavigate, or inside a transition the screen shows"
    ).toEqual([])
  })
})
