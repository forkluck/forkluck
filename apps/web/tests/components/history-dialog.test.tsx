// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const loadActivity = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  loadActivity,
  loadIngredientImports: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/app/(app)/ingredients/actions", () => ({
  undoIngredientImport: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { HistoryDialog } from "@/components/settings/history-dialog"
import type { ActivityEvent } from "@/lib/backend/types"

function event(partial: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "act-1",
    actorName: "Ana Reyes",
    resourceType: "recipe",
    resourceId: "rec-1",
    event: "edited",
    name: "Focaccia",
    context: {},
    createdAt: new Date("2026-08-23T14:43:00Z"),
    ...partial,
  }
}

function payload(items: ActivityEvent[], nextBefore: string | null = null) {
  return { items, nextBefore }
}

beforeEach(() => {
  loadActivity.mockResolvedValue(payload([]))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
  render(<HistoryDialog open onOpenChange={vi.fn()} />)
}

describe("the history dialog", () => {
  it("says what changed, to what, and by whom", async () => {
    loadActivity.mockResolvedValue(
      payload([
        event(),
        event({
          id: "act-2",
          resourceType: "category",
          resourceId: "cat-1",
          name: "Pastry",
          actorName: "Sam Okafor",
        }),
      ])
    )
    open()

    expect((await screen.findByText(/Recipe edited/)).textContent).toContain(
      "Recipe edited: Focaccia, by Ana Reyes"
    )
    expect(screen.getByText(/Category edited/).textContent).toContain(
      "Category edited: Pastry, by Sam Okafor"
    )
    expect(screen.getAllByText(/2026 \| /).length).toBe(2)
  })

  it("folds repeated saves of one resource into a single line", async () => {
    loadActivity.mockResolvedValue(
      payload([
        event(),
        event({ id: "act-2" }),
        event({ id: "act-3", resourceId: "rec-2", name: "Brioche" }),
      ])
    )
    open()

    const lines = await screen.findAllByText(/Recipe edited/)
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).toContain("Focaccia 2 times")
    expect(lines[1].textContent).toContain("Brioche,")
  })

  it("links a recipe by its public id", async () => {
    loadActivity.mockResolvedValue(
      payload([event({ context: { publicId: "abc123" } })])
    )
    open()

    const link = (await screen.findByRole("link", {
      name: "Focaccia",
    })) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/recipes/abc123/recipe")
  })

  it("reloads without the events a switch turned off", async () => {
    open()
    await screen.findByText("Nothing yet.")
    expect(loadActivity).toHaveBeenLastCalledWith({
      events: undefined,
      types: undefined,
    })

    fireEvent.click(screen.getByRole("button", { name: "Filter" }))
    fireEvent.click(await screen.findByRole("switch", { name: "Deleted" }))

    expect(loadActivity).toHaveBeenLastCalledWith({
      events: [
        "added",
        "edited",
        "archived",
        "restored",
        "imported",
        "connected",
        "disconnected",
      ],
      types: undefined,
    })
    expect(
      await screen.findByText("No entries match these filters.")
    ).toBeTruthy()
  })
})
