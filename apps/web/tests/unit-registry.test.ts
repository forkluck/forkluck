import { describe, expect, it } from "vitest"

import {
  countedAsEach,
  normalizePackUnit,
  PACK_UNIT_SLUGS,
  purchaseUnitOptions,
  unitWord,
  YIELD_UNIT_VALUES,
  yieldUnitOptions,
} from "@/lib/unit-registry"

describe("purchaseUnitOptions", () => {
  it("offers only the curated everyday purchasing units", () => {
    expect(purchaseUnitOptions().map((option) => option.slug)).toEqual([
      "g",
      "kg",
      "oz",
      "lb",
      "ml",
      "l",
      "fl-oz",
      "cup",
      "pt",
      "qt",
      "gal",
      "each",
      "dozen",
      "case",
      "pack",
      "bag",
      "box",
      "bottle",
      "can",
      "carton",
      "jar",
      "bunch",
    ])
  })

  it("offers exactly the slugs the import path stores", () => {
    expect(purchaseUnitOptions().map((option) => option.slug)).toEqual([
      ...PACK_UNIT_SLUGS,
    ])
  })
})

describe("normalizePackUnit", () => {
  it("reads the printed spellings of a weight and a volume", () => {
    expect(normalizePackUnit("LB")).toEqual({ slug: "lb", container: false })
    expect(normalizePackUnit("lbs.")).toEqual({ slug: "lb", container: false })
    expect(normalizePackUnit("OZ")).toEqual({ slug: "oz", container: false })
    expect(normalizePackUnit("FL OZ")).toEqual({
      slug: "fl-oz",
      container: false,
    })
    expect(normalizePackUnit("ML")).toEqual({ slug: "ml", container: false })
    expect(normalizePackUnit("GAL")).toEqual({ slug: "gal", container: false })
  })

  it("files every container word under each, and says it was one", () => {
    for (const word of [
      "CS",
      "CASE",
      "CAN",
      "BOTTLE",
      "CARTON",
      "PK",
      "BAG",
      "BOX",
      "JAR",
      "BUNCH",
    ]) {
      expect(normalizePackUnit(word)).toEqual({
        slug: "each",
        container: true,
      })
    }
  })

  it("counts pieces without calling them a container", () => {
    for (const word of ["CT", "COUNT", "PCS", "EA", "EACH"]) {
      expect(normalizePackUnit(word)).toEqual({
        slug: "each",
        container: false,
      })
    }
    expect(normalizePackUnit("DZ")).toEqual({ slug: "dozen", container: false })
  })

  it("names nothing for the multiplier or an unknown word", () => {
    expect(normalizePackUnit("X")).toBeNull()
    expect(normalizePackUnit("bushel")).toBeNull()
    expect(normalizePackUnit("  ")).toBeNull()
  })
})

describe("YIELD_UNIT_VALUES", () => {
  it("accepts every unit the Total yield menu offers, cups included", () => {
    const offered = yieldUnitOptions().map((unit) => unit.slug)
    expect([...YIELD_UNIT_VALUES].sort()).toEqual([...offered].sort())
    expect(YIELD_UNIT_VALUES).toContain("cup")
  })

  it("offers a slice beside pieces, under the same Count heading", () => {
    const options = yieldUnitOptions()
    const counts = options
      .filter((unit) => unit.heading === "Count")
      .map((unit) => [unit.slug, unit.label])
    expect(counts).toEqual([
      ["pcs", "Pieces (pcs)"],
      ["slice", "Slice"],
    ])
    expect(options.slice(0, 2).map((unit) => unit.slug)).toEqual([
      "pcs",
      "slice",
    ])
  })
})

describe("countedAsEach", () => {
  it("reads both of a yield's count spellings as one piece", () => {
    expect(countedAsEach("pcs")).toBe("each")
    expect(countedAsEach("slice")).toBe("each")
  })

  it("hands back everything else untouched", () => {
    expect(countedAsEach("each")).toBe("each")
    expect(countedAsEach("cup")).toBe("cup")
    expect(countedAsEach("g")).toBe("g")
    expect(countedAsEach("portion")).toBe("portion")
    expect(countedAsEach(null)).toBeNull()
  })
})

describe("unitWord", () => {
  it("says the unit the way a sentence does", () => {
    expect(unitWord("cup")).toBe("cup")
    expect(unitWord("g")).toBe("gram")
    expect(unitWord("fl-oz")).toBe("fluid ounce")
    expect(unitWord("each")).toBe("each")
    expect(unitWord("bunch")).toBe("bunch")
  })

  it("answers a counted yield in the word an ingredient uses", () => {
    expect(unitWord("pcs")).toBe("each")
  })

  it("falls back to an imported unit's own spelling, and to nothing", () => {
    expect(unitWord("bushel")).toBe("bushel")
    expect(unitWord(null)).toBe("")
  })
})
