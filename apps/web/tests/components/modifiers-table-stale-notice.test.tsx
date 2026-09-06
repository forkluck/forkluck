// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/app/(app)/products/actions", () => ({
  saveSalesModifierAssociations: vi.fn(),
}))

const { ModifiersTable } = await import("@/components/menu/modifiers-table")

afterEach(cleanup)

const EARLIER = "2026-08-13T10:00:00Z"
const LATER = "2026-08-13T11:00:00Z"

function renderTable(overrides: Record<string, unknown> = {}) {
  return render(
    <ModifiersTable
      lists={[]}
      unassignedRecords={[]}
      products={[]}
      squareConnected
      squareNeedsReconnect={false}
      squareSyncedAt={EARLIER}
      squareSalesSyncedAt={LATER}
      {...overrides}
    />
  )
}

describe("modifiers table stale notice", () => {
  it("tells the merchant to refresh when the catalog fell behind", () => {
    renderTable()

    expect(document.body.textContent).toContain(
      "behind your latest Square sync"
    )
  })

  it("points at reconnecting instead when Square needs it", () => {
    // Telling someone to refresh cannot work while the connection is broken.
    renderTable({ squareNeedsReconnect: true })

    expect(document.body.textContent).toContain("Reconnect Square in Settings")
    expect(document.body.textContent).not.toContain("Refresh to bring them")
  })

  it("shows no notice once the catalog is current", () => {
    renderTable({ squareSyncedAt: LATER, squareSalesSyncedAt: EARLIER })

    expect(screen.queryByText(/behind your latest Square sync/)).toBeNull()
    expect(document.body.textContent).toContain("No Square modifier lists")
  })
})
