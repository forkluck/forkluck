// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const undoSalesImport = vi.hoisted(() => vi.fn())
const retryPosSync = vi.hoisted(() => vi.fn())

vi.mock("@/app/(app)/sales/actions", () => ({
  undoSalesImport: (...args: unknown[]) => undoSalesImport(...args),
  retryPosSync: (...args: unknown[]) => retryPosSync(...args),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ timezone: "UTC" }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { SalesActivity } from "@/components/integrations/sales-activity"
import type { PosSyncRun, SalesImportRow } from "@/lib/backend/types"

function salesImport(partial: Partial<SalesImportRow>): SalesImportRow {
  return {
    id: "import-1",
    fileName: "Square sync",
    channel: "square",
    providerAccountId: "acct-1",
    source: "api",
    timezone: "UTC",
    currencyCode: "USD",
    periodStart: null,
    periodEnd: null,
    totalRows: 4,
    importedCount: 4,
    duplicateCount: 0,
    skippedCount: 0,
    ignoredCount: 0,
    orderCount: 2,
    grossCents: 1000,
    discountCents: 0,
    netSalesCents: 1000,
    taxCents: 0,
    refundCents: 0,
    createdAt: new Date("2026-08-27T10:00:00Z"),
    undoneAt: null,
    canUndo: false,
    ...partial,
  }
}

function syncRun(partial: Partial<PosSyncRun>): PosSyncRun {
  return {
    id: "run-1",
    provider: "square",
    providerAccountId: "acct-1",
    connectionGeneration: 1,
    status: "succeeded",
    progress: {},
    cursor: { watermark: null, continuationPasses: 0 },
    result: {},
    error: "",
    attempts: 1,
    maxAttempts: 3,
    queuedAt: "2026-08-27T10:00:00Z",
    availableAt: "2026-08-27T10:00:00Z",
    startedAt: "2026-08-27T10:00:01Z",
    heartbeatAt: null,
    finishedAt: "2026-08-27T10:01:00Z",
    ...partial,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Sales activity", () => {
  it("undoes an import only after the confirm click", async () => {
    undoSalesImport.mockResolvedValue({ ok: true, deletedLines: 4 })
    render(
      <SalesActivity
        imports={[
          salesImport({ canUndo: true }),
          salesImport({ id: "import-2", fileName: "Shopify sync" }),
        ]}
        syncRuns={[]}
      />
    )

    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(undoSalesImport).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Confirm undo" }))
    await waitFor(() =>
      expect(undoSalesImport).toHaveBeenCalledWith("import-1")
    )
  })

  it("offers a retry on a failed run only", async () => {
    retryPosSync.mockResolvedValue({ syncRun: { id: "run-2" } })
    render(
      <SalesActivity
        imports={[]}
        syncRuns={[
          syncRun({}),
          syncRun({ id: "run-2", provider: "shopify", status: "failed" }),
        ]}
      />
    )

    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(retryPosSync).toHaveBeenCalledWith("run-2"))
  })

  it("says so when neither list has a row", () => {
    render(<SalesActivity imports={[]} syncRuns={[]} />)

    expect(screen.getByText("No sales imports yet.")).toBeDefined()
    expect(screen.getByText("No sync runs yet.")).toBeDefined()
  })
})
