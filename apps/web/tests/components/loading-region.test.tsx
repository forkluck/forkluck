// @vitest-environment jsdom

import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { LoadingRegion } from "@/components/ui/loading-region"

afterEach(cleanup)

describe("LoadingRegion", () => {
  it("shows nothing extra while idle", () => {
    render(
      <LoadingRegion pending={false} label="Loading page">
        <p>Old numbers</p>
      </LoadingRegion>
    )
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText("Old numbers").closest("[aria-busy]")).toBeNull()
  })

  it("marks the region busy and names the wait while pending", () => {
    render(
      <LoadingRegion pending label="Loading page">
        <p>Old numbers</p>
      </LoadingRegion>
    )
    // A status region takes no name from its contents, so read the text.
    expect(screen.getByRole("status").textContent).toBe("Loading page")
    const region = screen.getByText("Old numbers").closest("[aria-busy='true']")
    expect(region).not.toBeNull()
    // The old content stays for orientation but cannot be clicked.
    expect(screen.getByText("Old numbers").parentElement?.className).toContain(
      "pointer-events-none"
    )
  })
})
