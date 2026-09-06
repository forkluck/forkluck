// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import { PrimoResultCard } from "@/components/primo/primo-result-card"
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

describe("Primo result card", () => {
  it("makes the resolved default period and current-recipe basis explicit", () => {
    render(
      <PrimoResultCard result={emptyResult(null)} onSuggestion={vi.fn()} />
    )

    expect(screen.getByText("May 26 – Aug 24, 2026")).toBeDefined()
    expect(screen.getByText("Default 90 days")).toBeDefined()
    expect(
      screen.getByText(/today's recipe quantities, yields, and conversions/i)
    ).toBeDefined()
    expect(
      screen.getByText(
        "No price changes in this period, and Forkluck has no earlier price history for this recipe."
      )
    ).toBeDefined()
  })

  it("offers an explicit full-date comparison for an earlier change", () => {
    const onSuggestion = vi.fn()
    render(
      <PrimoResultCard
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

  it("distinguishes price movement from a zero net recipe delta", () => {
    const result = emptyResult(null)
    result.priceChangesInWindow = 2

    render(<PrimoResultCard result={result} onSuggestion={vi.fn()} />)

    expect(screen.getByText(/prices moved during the period/i)).toBeDefined()
    expect(screen.queryByRole("button", { name: /compare since/i })).toBeNull()
  })
})
