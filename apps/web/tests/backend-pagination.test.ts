import { describe, expect, it } from "vitest"

import {
  allowedSearchParam,
  browsePath,
  browseSearchParams,
  positivePage,
  singleSearchParam,
} from "../lib/backend/pagination"

describe("browse pagination", () => {
  it("uses one stable query vocabulary and omits empty values", () => {
    expect(
      browseSearchParams({
        page: 3,
        limit: 50,
        q: "  flour  ",
        order: "-updatedAt",
        filters: { status: "active", category: null },
      }).toString()
    ).toBe("page=3&limit=50&q=flour&order=-updatedAt&status=active")
  })

  it("carries the active kitchen, and omits the user's own", () => {
    expect(
      browseSearchParams({
        filters: { status: "active", kitchen: "user-rosa" },
      }).toString()
    ).toBe("status=active&kitchen=user-rosa")
    expect(
      browseSearchParams({
        filters: { status: "active", kitchen: null },
      }).toString()
    ).toBe("status=active")
  })

  it("does not add a question mark for a default browse", () => {
    expect(browsePath("/internal/v1/recipes/", {})).toBe(
      "/internal/v1/recipes/"
    )
  })

  it("builds a recovery URL without stale or empty controls", () => {
    expect(
      browsePath("/recipes", {
        q: "bread flour",
        filters: { status: "active", category: "" },
      })
    ).toBe("/recipes?q=bread+flour&status=active")
  })

  it("normalizes untrusted Next search params", () => {
    expect(singleSearchParam(["one", "two"])).toBeUndefined()
    expect(singleSearchParam("one")).toBe("one")
    expect(positivePage("4")).toBe(4)
    expect(positivePage("-1")).toBe(1)
    expect(positivePage("wat")).toBe(1)
    expect(allowedSearchParam("-name", ["name", "-name"], "name")).toBe("-name")
    expect(allowedSearchParam("price", ["name", "-name"], "name")).toBe("name")
  })
})
