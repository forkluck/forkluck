import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"
import { read, utils, version, write } from "xlsx"

// The patched releases are published as SheetJS CDN tarballs rather than to the
// public npm registry, so the manifest pins a URL like
// ".../xlsx-0.20.3/xlsx-0.20.3.tgz" instead of a semver range. Two separate
// things can therefore go wrong, and both are checked below:
//
//   1. The manifest pin gets moved back to a vulnerable release.
//   2. The manifest pin is fine but the installed tree is stale, so the code
//      that actually runs is an older registry build (0.18.5 still resolves
//      from npm). Only the runtime `version` export catches this one.
const MINIMUM_SAFE_VERSION = "0.20.2"

function pinnedVersionFromManifest() {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { dependencies?: Record<string, string> }
  const specifier = manifest.dependencies?.xlsx
  expect(specifier, "xlsx must stay a pinned dependency").toBeTruthy()
  // Matches both a tarball URL (xlsx-0.20.3.tgz) and a plain semver pin.
  const pinned = specifier?.match(/(\d+\.\d+\.\d+)(?:\.tgz)?$/)?.[1]
  expect(
    pinned,
    `could not read a version out of xlsx pin "${specifier}"`
  ).toBeTruthy()
  return pinned as string
}

function isVersionAtLeast(candidate: string, minimum: string) {
  const [candidateMajor = 0, candidateMinor = 0, candidatePatch = 0] = candidate
    .split(".")
    .map(Number)
  const [minimumMajor = 0, minimumMinor = 0, minimumPatch = 0] = minimum
    .split(".")
    .map(Number)
  const semanticOrder =
    candidateMajor - minimumMajor ||
    candidateMinor - minimumMinor ||
    candidatePatch - minimumPatch
  return semanticOrder >= 0
}

describe("spreadsheet reader security upgrade", () => {
  it("pins a release containing the prototype-pollution and ReDoS fixes", () => {
    const pinned = pinnedVersionFromManifest()
    expect(
      isVersionAtLeast(pinned, MINIMUM_SAFE_VERSION),
      `package.json pins xlsx ${pinned}, which is older than ${MINIMUM_SAFE_VERSION}`
    ).toBe(true)
  })

  it("runs a release containing the prototype-pollution and ReDoS fixes", () => {
    expect(
      isVersionAtLeast(version, MINIMUM_SAFE_VERSION),
      `the installed xlsx reports ${version}, older than ${MINIMUM_SAFE_VERSION}. ` +
        "If package.json pins a newer release, the dependency tree is stale — run pnpm install."
    ).toBe(true)
  })

  it("orders versions correctly", () => {
    expect(isVersionAtLeast("0.21.0", MINIMUM_SAFE_VERSION)).toBe(true)
    expect(isVersionAtLeast("1.0.0", MINIMUM_SAFE_VERSION)).toBe(true)
    expect(isVersionAtLeast("0.20.1", MINIMUM_SAFE_VERSION)).toBe(false)
    expect(isVersionAtLeast("0.18.5", MINIMUM_SAFE_VERSION)).toBe(false)
    expect(isVersionAtLeast("0.19.9", MINIMUM_SAFE_VERSION)).toBe(false)
  })

  it.each(["xlsx", "biff8"] as const)(
    "preserves %s spreadsheet imports",
    (bookType) => {
      const workbook = utils.book_new()
      utils.book_append_sheet(
        workbook,
        utils.aoa_to_sheet([
          ["Ingredient", "Price"],
          ["Flour", 12.5],
        ]),
        "Prices"
      )
      const bytes = write(workbook, { bookType, type: "buffer" })
      const loaded = read(bytes, { type: "buffer" })
      const rows = utils.sheet_to_json<unknown[]>(
        loaded.Sheets[loaded.SheetNames[0]],
        { header: 1, defval: "" }
      )

      expect(rows).toEqual([
        ["Ingredient", "Price"],
        ["Flour", 12.5],
      ])
    }
  )

  it("preserves CSV imports", () => {
    const workbook = read('Ingredient,Price\n"Whole, Milk",4.25', {
      type: "string",
    })
    const rows = utils.sheet_to_json<unknown[]>(
      workbook.Sheets[workbook.SheetNames[0]],
      { header: 1, defval: "" }
    )

    expect(rows).toEqual([
      ["Ingredient", "Price"],
      ["Whole, Milk", 4.25],
    ])
  })
})
