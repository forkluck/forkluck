// @vitest-environment jsdom

import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const searchApp = vi.hoisted(() => vi.fn())

vi.mock("@/app/(app)/actions", () => ({ searchApp }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  searchApp.mockReset()
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
    render(<AppSearch />)

    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())

    const input = screen.getByRole("combobox", { name: "Search Forkluck" })
    fireEvent.change(input, { target: { value: "banana" } })
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText("Banana bread")).toBeTruthy()

    fireEvent.click(screen.getByText("Close search"))
    fireEvent.click(screen.getByLabelText("Search Forkluck"))
    await act(async () => vi.runOnlyPendingTimers())

    expect(screen.queryByText("Banana bread")).toBeNull()
    expect(screen.getByText("Searching…")).toBeTruthy()

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
})
