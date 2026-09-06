// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const loadActivity = vi.hoisted(() => vi.fn())
const loadIngredientImports = vi.hoisted(() => vi.fn())
const undoIngredientImport = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  loadActivity,
  loadIngredientImports,
}))
vi.mock("@/app/(app)/ingredients/actions", () => ({ undoIngredientImport }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { HistoryDialog } from "@/components/settings/history-dialog"
import type { ActivityEvent, IngredientImportRow } from "@/lib/backend/types"

function event(id: string, name: string): ActivityEvent {
  return {
    id: `act-${id}`,
    actorName: "Ana Reyes",
    resourceType: "import",
    resourceId: id,
    event: "imported",
    name,
    context: { kind: "ingredients", imported: 12, created: 3, updated: 9 },
    createdAt: new Date("2026-08-23T14:43:00Z"),
  }
}

function importRow(id: string, canUndo: boolean): IngredientImportRow {
  return {
    id,
    fileName: "sysco-week-34.csv",
    supplier: "Sysco",
    periodStart: null,
    periodEnd: null,
    totalRows: 12,
    importedCount: 12,
    createdCount: 3,
    updatedCount: 9,
    reviewCount: 0,
    ignoredCount: 0,
    createdAt: new Date("2026-08-23T14:43:00Z"),
    undoneAt: null,
    canUndo,
  }
}

beforeEach(() => {
  loadActivity.mockResolvedValue({
    items: [event("imp-1", "sysco-week-34.csv"), event("imp-2", "older.csv")],
    nextBefore: null,
  })
  loadIngredientImports.mockResolvedValue([
    importRow("imp-1", true),
    importRow("imp-2", false),
  ])
  undoIngredientImport.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("undoing an ingredients import from the history", () => {
  it("says what the import did to the pantry", async () => {
    render(<HistoryDialog open onOpenChange={vi.fn()} />)

    const fileName = await screen.findByText("sysco-week-34.csv")
    expect(fileName.parentElement?.textContent).toContain(
      "Imported sysco-week-34.csv · 12 imported · 3 new · 9 updated"
    )
  })

  it("arms the undo before it runs, and only for the newest import", async () => {
    render(<HistoryDialog open onOpenChange={vi.fn()} />)

    const undo = await screen.findByRole("button", { name: "Undo" })
    expect(screen.queryAllByRole("button", { name: "Undo" })).toHaveLength(1)

    fireEvent.click(undo)
    expect(undoIngredientImport).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole("button", { name: "Confirm undo" }))
    expect(undoIngredientImport).toHaveBeenCalledWith("imp-1")
  })

  it("shows an import that was already undone as undone", async () => {
    loadIngredientImports.mockResolvedValue([
      { ...importRow("imp-1", false), undoneAt: new Date() },
      importRow("imp-2", false),
    ])
    render(<HistoryDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("Undone")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
  })
})
