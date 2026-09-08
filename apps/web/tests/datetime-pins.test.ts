import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { sourceFiles } from "./source-files"

/**
 * Every date the app prints comes through lib/datetime.ts, in one locale and
 * on one clock. The app once printed "9 Aug" beside "Aug 9" on one screen,
 * and a shift time in 24-hour next to a sync time in 12-hour, because forty
 * formatters were built where they were used. Two probes are allowed: the
 * zone validators, which format nothing.
 */
const HOME = "lib/datetime.ts"
const PROBES = new Set([
  "lib/business-settings.ts",
  "app/(app)/labor/actions.ts",
])
/** The clock, not a display format: it builds the YYYY-MM-DD key for a zone. */
const CLOCK = "lib/date-presets.ts"

const FORMATTER = /\bIntl\.DateTimeFormat\(/
const LOCALE_METHOD = /\.toLocale(?:Date|Time)String\(/
// A number's toLocaleString stays; a date's carries a date option.
const LOCALE_STRING_WITH_DATE_OPTIONS =
  /\.toLocaleString\([^)]*\b(?:month|day|year|weekday|hour|minute|dateStyle|timeStyle)\s*:/

function offenders(): string[] {
  const found: string[] = []
  for (const file of [
    ...sourceFiles("app"),
    ...sourceFiles("components"),
    ...sourceFiles("hooks"),
    ...sourceFiles("lib"),
  ]) {
    if (file === HOME || file === CLOCK || PROBES.has(file)) continue
    const source = readFileSync(file, "utf8")
    source.split("\n").forEach((line, index) => {
      if (FORMATTER.test(line) || LOCALE_METHOD.test(line))
        found.push(`${file}:${index + 1}`)
    })
    if (LOCALE_STRING_WITH_DATE_OPTIONS.test(source)) found.push(file)
  }
  return found
}

describe("dates", () => {
  it("are printed through lib/datetime.ts and nowhere else", () => {
    expect(offenders(), "print dates through lib/datetime.ts").toEqual([])
  })
})
