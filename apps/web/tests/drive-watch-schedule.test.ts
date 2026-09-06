import { describe, expect, it } from "vitest"

import { driveWatchInterval } from "@/instrumentation"

describe("driveWatchInterval", () => {
  it("is off unless the deployment asks for it", () => {
    expect(driveWatchInterval(undefined)).toBeNull()
    expect(driveWatchInterval("")).toBeNull()
    expect(driveWatchInterval("0")).toBeNull()
    expect(driveWatchInterval("-30")).toBeNull()
    expect(driveWatchInterval("often")).toBeNull()
  })

  it("polls no faster than once a minute", () => {
    expect(driveWatchInterval("300")).toBe(300)
    expect(driveWatchInterval("30")).toBe(60)
    expect(driveWatchInterval("90.4")).toBe(90)
  })
})
