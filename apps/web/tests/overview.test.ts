import { describe, expect, it } from "vitest"

import { averageFoodCost, type OverviewRecipe } from "../lib/overview"

const recipes: OverviewRecipe[] = [
  {
    id: "recent",
    publicId: "rcp_recent",
    title: "Recent",
    foodCost: 0.25,
    issues: [],
  },
  {
    id: "older",
    publicId: "rcp_older",
    title: "Older",
    foodCost: 0.45,
    issues: [],
  },
  {
    id: "unpriced",
    publicId: "rcp_unpriced",
    title: "Unpriced",
    foodCost: null,
    issues: ["1 unpriced"],
  },
]

describe("overview metrics", () => {
  it("averages only recipes with a calculable food cost", () => {
    expect(averageFoodCost(recipes)).toBeCloseTo(0.35)
    expect(averageFoodCost([recipes[2]])).toBeNull()
  })
})
