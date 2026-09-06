import { describe, expect, it } from "vitest"

import { parseRecipeStatusFilter } from "../components/recipes/types"

describe("parseRecipeStatusFilter", () => {
  it("defaults recipes to active and rejects an unknown status", () => {
    expect(parseRecipeStatusFilter("unknown")).toBe("active")
    expect(parseRecipeStatusFilter()).toBe("active")
  })

  it("allows an explicit all-status URL", () => {
    expect(parseRecipeStatusFilter("all")).toBeNull()
  })

  it("keeps the archived status", () => {
    expect(parseRecipeStatusFilter("archived")).toBe("archived")
  })
})
