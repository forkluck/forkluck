// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import { PrimoCostLinks } from "@/components/primo/primo-cost-links"
import type { RecipeCostDiff } from "@/lib/backend/types"

afterEach(cleanup)

function emptyResult(
  lastChangeBeforeWindow: RecipeCostDiff["lastChangeBeforeWindow"]
): RecipeCostDiff {
  return {
    recipe: { id: "1", publicId: "rcp_0123456789ab", title: "Butter cake" },
    window: {
      fromAt: "2026-05-26T00:00:00+00:00",
      toAt: "2026-08-24T18:30:00+00:00",
      fromDate: "2026-05-26",
      toDate: "2026-08-24",
      days: 90,
      source: "default90Days",
      comparison: "priceOnlyCurrentRecipeBasis",
    },
    basis: "Price-only comparison using the current recipe.",
    totals: {
      fromCents: 100,
      toCents: 100,
      deltaCents: 0,
      fromComplete: true,
      toComplete: true,
      comparableFromCents: 100,
      comparableToCents: 100,
      comparableDeltaCents: 0,
    },
    coverage: { requiredLines: 1, comparableBoth: 1, skippedLines: 0 },
    priceChangesInWindow: 0,
    lastChangeBeforeWindow,
    lines: [],
    issues: [],
    currencyCode: "USD",
  }
}

describe("Primo cost links", () => {
  it("offers an explicit full-date comparison for an earlier change", () => {
    const onSuggestion = vi.fn()
    render(
      <PrimoCostLinks
        result={emptyResult({
          at: "2026-05-12T00:00:00+00:00",
          ingredient: {
            publicId: "ing_0123456789ab",
            name: "Butter",
          },
        })}
        onSuggestion={onSuggestion}
      />
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Compare since May 12, 2026" })
    )
    expect(onSuggestion).toHaveBeenCalledWith(
      "Compare this recipe since May 12, 2026."
    )
  })

  it("keeps the Cost tab link without repeating the comparison figures", () => {
    render(<PrimoCostLinks result={emptyResult(null)} onSuggestion={vi.fn()} />)
    expect(
      screen.getByRole("link", { name: "Open Cost tab" }).getAttribute("href")
    ).toBe("/recipes/rcp_0123456789ab/cost")
    expect(
      screen.queryByText(/price changes|Default 90 days|Recipe cost change/)
    ).toBeNull()
  })
})
