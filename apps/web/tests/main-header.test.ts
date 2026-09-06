import { describe, expect, it } from "vitest"

import type { PosConnectionRow } from "../lib/backend/types"
import { connectionState, updatedLabel } from "../lib/connection-status"

function connection(
  overrides: Partial<PosConnectionRow> = {}
): PosConnectionRow {
  return {
    provider: "square",
    providerAccountId: "merchant",
    generation: 1,
    status: "active",
    merchantId: "merchant",
    shopDomain: "",
    scopes: "",
    providerTimezone: "UTC",
    currencyCode: "USD",
    lastSyncedAt: "2026-08-12T12:00:00Z",
    backfilledAt: null,
    lastError: "",
    connectedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  }
}

describe("header connection freshness", () => {
  const now = new Date("2026-08-12T12:42:00Z").getTime()

  it("uses the oldest provider sync so a fresh channel cannot hide a stale one", () => {
    const state = connectionState(
      [
        connection({ lastSyncedAt: "2026-08-12T12:40:00Z" }),
        connection({
          provider: "shopify",
          lastSyncedAt: "2026-08-12T11:30:00Z",
        }),
      ],
      now
    )
    expect(state.label).toBe("Updated 1 hour ago")
    expect(state.title).toContain("Shopify last synced")
  })

  it("moves old sync ages from minutes to hours and days", () => {
    expect(updatedLabel(0)).toBe("Updated just now")
    expect(updatedLabel(1)).toBe("Updated 1 minute ago")
    expect(updatedLabel(59)).toBe("Updated 59 minutes ago")
    expect(updatedLabel(60)).toBe("Updated 1 hour ago")
    expect(updatedLabel(120)).toBe("Updated 2 hours ago")
    expect(updatedLabel(1_440)).toBe("Updated 1 day ago")
    expect(updatedLabel(2_208)).toBe("Updated 2 days ago")
  })

  it("represents never-synced and disconnected accounts explicitly", () => {
    expect(
      connectionState([connection({ lastSyncedAt: null })], now)
    ).toMatchObject({ label: "Never synced", dot: "bg-warning" })
    expect(connectionState([], now)).toMatchObject({
      label: "No channels connected",
      dot: "bg-line-strong",
    })
  })

  it("distinguishes a failed connection lookup from no connected channels", () => {
    expect(connectionState(null, now)).toMatchObject({
      label: "Status unavailable",
      dot: "bg-line-strong",
    })
    expect(connectionState([], now).label).toBe("No channels connected")
  })

  it("does not claim a fresh timestamp before the client clock starts", () => {
    expect(connectionState([connection()], null).label).toBe(
      "Last sync recorded"
    )
  })
})
