import { describe, expect, it } from "vitest"

import { listNames } from "@/lib/recipe/names"

describe("naming a list", () => {
  it("names one", () => {
    expect(listNames(["Queenie Fok"])).toBe("Queenie Fok")
  })

  it("joins two with and", () => {
    expect(listNames(["Queenie Fok", "Jo Doe"])).toBe("Queenie Fok and Jo Doe")
  })

  it("names the first two and counts the rest", () => {
    expect(listNames(["Queenie Fok", "Jo Doe", "Ana", "Bo"])).toBe(
      "Queenie Fok, Jo Doe and 2 more"
    )
  })
})
