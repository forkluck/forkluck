import { describe, expect, it } from "vitest"

import {
  costIssueLine,
  costIssueMessage,
  costIssueSummary,
} from "@/lib/menu/cost-issues"

describe("cost issues", () => {
  it("names the two bundle failures", () => {
    expect(
      costIssueMessage({ code: "product-cycle", path: [], detail: null })
    ).toBe("This product contains itself")
    expect(
      costIssueMessage({ code: "unresolved-product", path: [], detail: null })
    ).toBe("A product inside this one could not be found")
  })

  it("reads the product chain outermost first", () => {
    expect(
      costIssueLine({
        code: "unresolved-product",
        path: ["Mid-Autumn Kit", "Mooncake Box"],
        detail: null,
      })
    ).toBe(
      "Mid-Autumn Kit · Mooncake Box — A product inside this one could not be found"
    )
  })

  it("falls back on a code minted without copy", () => {
    expect(
      costIssueMessage({ code: "brand-new-code", path: [], detail: null })
    ).toBe("This cannot be costed yet")
    expect(
      costIssueSummary([
        { code: "product-cycle", path: ["Gift Kit"], detail: null },
        { code: "unresolved-product", path: ["Gift Kit"], detail: null },
      ])
    ).toBe("2 things to fix before this can be costed")
  })
})
