import { describe, expect, it } from "vitest"
import { safeAuthNext } from "@/lib/auth-next"

describe("auth continuation", () => {
  it.each([
    undefined,
    ["/recipes", "/"],
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\n/evil.test",
    "/\t/evil.test",
    "javascript:alert(1)",
    "/has space",
    "/has\x7fdelete",
    "/" + "x".repeat(8192),
    "/" + "🍞".repeat(4096),
  ])("rejects an unsafe or ambiguous destination %j", (next) => {
    expect(safeAuthNext(next)).toBe("/")
  })

  it.each([
    "/recipes?selected=one",
    "/recipes?view=all#row",
    "/" + "x".repeat(8191),
    "/api/auth/google/start?next=%2Frecipes",
    "/api/auth/feedback/authorize?state=opaque&scope=profile",
  ])("preserves a local continuation %s", (next) => {
    expect(safeAuthNext(next)).toBe(next)
  })
})
