import { describe, expect, it } from "vitest"

import { toSearchItems } from "../components/search/search-items"

describe("toSearchItems", () => {
  it("keeps canonical labels and maps domain types to display groups", () => {
    expect(
      toSearchItems([
        {
          label: "Strong flour",
          href: "/ingredients",
          type: "ingredient",
        },
      ])
    ).toEqual([
      {
        label: "Strong flour",
        href: "/ingredients",
        group: "Ingredients",
      },
    ])
  })
})
