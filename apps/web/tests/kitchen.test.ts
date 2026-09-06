import { describe, expect, it } from "vitest"

import type { SessionPayload } from "../lib/backend/schemas"
import { resolveActiveKitchen } from "../lib/kitchen"

const ROSA = {
  id: "mem-1",
  ownerId: "user-rosa",
  ownerName: "Rosa",
  role: "editor",
} as const
const OMAR = {
  id: "mem-2",
  ownerId: "user-omar",
  ownerName: "Omar",
  role: "viewer",
} as const

function session(
  kitchens: SessionPayload["kitchens"],
  recipeCount: number
): SessionPayload {
  return {
    billing: { recipeCount },
    kitchens,
  } as SessionPayload
}

describe("which kitchen a request is in", () => {
  it("follows the cookie to the membership it names", () => {
    expect(resolveActiveKitchen(session([ROSA, OMAR], 4), "user-omar")).toEqual(
      OMAR
    )
  })

  it("falls back to the user's own kitchen with no cookie", () => {
    expect(resolveActiveKitchen(session([ROSA], 4), undefined)).toBeNull()
  })

  it("treats a revoked or unknown membership as the user's own kitchen", () => {
    expect(resolveActiveKitchen(session([ROSA], 4), "user-gone")).toBeNull()
    expect(resolveActiveKitchen(session([], 4), "user-rosa")).toBeNull()
  })

  it("lands invited staff in the kitchen that invited them", () => {
    expect(resolveActiveKitchen(session([ROSA, OMAR], 0), undefined)).toEqual(
      ROSA
    )
  })

  it("leaves an owner with recipes of their own where they are", () => {
    expect(resolveActiveKitchen(session([ROSA], 1), undefined)).toBeNull()
    expect(resolveActiveKitchen(session([], 0), undefined)).toBeNull()
  })
})
