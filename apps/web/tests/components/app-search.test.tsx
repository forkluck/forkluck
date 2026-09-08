// @vitest-environment jsdom

import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { searchApp, go } = vi.hoisted(() => ({
  searchApp: vi.fn(),
  go: vi.fn().mockResolvedValue(true),
}))

vi.mock("@/app/(app)/actions", () => ({ searchApp }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go, pending: false }),
  useNavigationBlocker: () => ({
    allowNavigation: vi.fn(),
    confirmNavigation: vi.fn().mockResolvedValue(true),
  }),
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) =>
    open ? (
      <div>
        {children}
        <button type="button" onClick={() => onOpenChange(false)}>
          Close search
        </button>
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}))

import { AppSearch } from "@/components/app-search"
import type { SearchItem } from "@/components/search/search-items"

const PLACES: SearchItem[] = [
  { label: "Recipes", href: "/recipes", group: "Go to" },
  { label: "Labor", href: "/labor", group: "Go to" },
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  searchApp.mockReset()
  go.mockClear()
  vi.useFakeTimers()
})

describe("app search", () => {
  it("clears the previous query before a reopened palette can select it", async () => {
    let resolveReopen: ((items: never[]) => void) | undefined
    searchApp
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          label: "Banana bread",
          href: "/recipes/banana",
          group: "Recipes",
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise<never[]>((resolve) => {
            resolveReopen = resolve
          })
      )
    render(<AppSearch places={PLACES} />)

    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())

    const input = screen.getByRole("combobox", { name: "Search Forkluck" })
    fireEvent.change(input, { target: { value: "banana" } })
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText("Banana bread")).toBeTruthy()

    fireEvent.click(screen.getByText("Close search"))
    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())

    // The palette reopens on the places to go, never on the old result and
    // never on a blank "Searching…" while the default payload is in flight.
    expect(screen.queryByText("Banana bread")).toBeNull()
    expect(screen.queryByText("Searching…")).toBeNull()
    expect(screen.getByRole("option", { name: "Recipes" })).toBeTruthy()

    await act(async () => resolveReopen?.([]))
  })

  it("keeps matching results on screen while the user is still typing", async () => {
    searchApp
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          label: "Granulated sugar",
          href: "/ingredients?q=Granulated+sugar",
          group: "Ingredients",
        },
      ])
      .mockImplementation(() => new Promise(() => {}))
    render(<AppSearch />)

    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())

    const input = screen.getByRole("combobox", { name: "Search Forkluck" })
    fireEvent.change(input, { target: { value: "sug" } })
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText("Granulated sugar")).toBeTruthy()

    // Typing on refines the already-loaded results locally; the row must not
    // vanish behind a "Searching…" placeholder while the refresh is pending.
    fireEvent.change(input, { target: { value: "sugar" } })
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText("Granulated sugar")).toBeTruthy()
    expect(screen.queryByText("Searching…")).toBeNull()
  })

  it("reaches a screen from the keyboard before any request has landed", async () => {
    searchApp.mockImplementation(() => new Promise(() => {}))
    render(<AppSearch places={PLACES} />)

    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())
    expect(screen.getByText("Go to")).toBeTruthy()

    const input = screen.getByRole("combobox", { name: "Search Forkluck" })
    fireEvent.change(input, { target: { value: "lab" } })
    // Places filter as the user types: Recipes leaves, Labor stays and is
    // the row Enter takes.
    expect(screen.queryByRole("option", { name: "Recipes" })).toBeNull()
    expect(screen.getByRole("option", { name: "Labor" })).toBeTruthy()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(go).toHaveBeenCalledWith("/labor")
  })
})
