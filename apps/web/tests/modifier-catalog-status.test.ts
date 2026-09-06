import { describe, expect, it } from "vitest"

import { isModifierCatalogStale } from "../lib/modifier-catalog-status"

const EARLIER = "2026-08-13T10:00:00Z"
const LATER = "2026-08-13T11:00:00Z"

describe("modifier catalog staleness", () => {
  it("flags a catalog left behind by a later sales sync", () => {
    // The guarded catalog step failed, so sales moved on without it.
    expect(
      isModifierCatalogStale({
        squareConnected: true,
        squareSyncedAt: EARLIER,
        squareSalesSyncedAt: LATER,
      })
    ).toBe(true)
  })

  it("stays quiet when the catalog imported after the orders", () => {
    // A healthy run always stamps the catalog last.
    expect(
      isModifierCatalogStale({
        squareConnected: true,
        squareSyncedAt: LATER,
        squareSalesSyncedAt: EARLIER,
      })
    ).toBe(false)
  })

  it("flags sales that arrived without the catalog ever importing", () => {
    expect(
      isModifierCatalogStale({
        squareConnected: true,
        squareSyncedAt: null,
        squareSalesSyncedAt: LATER,
      })
    ).toBe(true)
  })

  it("stays quiet before the first sync has run", () => {
    expect(
      isModifierCatalogStale({
        squareConnected: true,
        squareSyncedAt: null,
        squareSalesSyncedAt: null,
      })
    ).toBe(false)
  })

  it("stays quiet when Square is not connected", () => {
    expect(
      isModifierCatalogStale({
        squareConnected: false,
        squareSyncedAt: null,
        squareSalesSyncedAt: LATER,
      })
    ).toBe(false)
  })
})
