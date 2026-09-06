// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ timezone: "UTC" }),
}))

import { SupplierActivity } from "@/components/integrations/supplier-activity"
import type { ConnectorProvider, ConnectorSyncRun } from "@/lib/backend/types"

const providers: ConnectorProvider[] = [
  {
    key: "acme",
    displayName: "Acme Produce",
    description: "Invoices from Acme Produce.",
    icon: "package",
    capabilities: ["invoices"],
    available: true,
  },
]

function run(partial: Partial<ConnectorSyncRun>): ConnectorSyncRun {
  return {
    id: "run-1",
    providerKey: "acme",
    remoteRunId: null,
    status: "succeeded",
    progress: {
      pagesDone: 1,
      documentsSeen: 3,
      documentsImported: 2,
      documentsSkipped: 1,
      linesNeedingReview: 0,
    },
    error: null,
    queuedAt: "2026-08-27T10:00:00Z",
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    ...partial,
  }
}

afterEach(cleanup)

describe("Supplier activity", () => {
  it("names a run by its provider, falling back to the raw key", () => {
    render(
      <SupplierActivity
        runs={[run({}), run({ id: "run-2", providerKey: "vestal" })]}
        providers={providers}
      />
    )

    expect(screen.getByText("Acme Produce")).toBeDefined()
    expect(screen.getByText("vestal")).toBeDefined()
  })

  it("shows when a run started, and when it was queued until it does", () => {
    render(
      <SupplierActivity
        runs={[
          run({ startedAt: "2026-08-27T10:00:05Z" }),
          run({ id: "run-2", status: "queued" }),
        ]}
        providers={providers}
      />
    )

    expect(screen.getByText(/^Started /)).toBeDefined()
    expect(screen.getByText(/^Queued /)).toBeDefined()
  })

  it("says so when no supplier has synced", () => {
    render(<SupplierActivity runs={[]} providers={providers} />)

    expect(screen.getByText("No supplier syncs yet.")).toBeDefined()
  })
})
