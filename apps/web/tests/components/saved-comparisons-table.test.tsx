// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/** The Compare list: every saved comparison by name, opened at its own address. */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
const go = vi.hoisted(() => vi.fn())
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go, pending: false }),
  GuardedLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children?: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))
const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD", timezone: "UTC" }),
}))
const deleteComparison = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/recipes/compare/actions", () => ({
  deleteComparison,
}))

import { SavedComparisonsTable } from "@/components/recipes/saved-comparisons-table"
import type { SavedComparisonRow } from "@/lib/backend/types"

const ROWS: SavedComparisonRow[] = [
  {
    id: "uuid-1",
    publicId: "cmp_loaves",
    title: "Loaves",
    view: "formula",
    columnTitles: ["Country loaf", "Brioche"],
    columnCount: 2,
    updatedAt: new Date("2026-09-12T10:00:00Z"),
  },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the saved comparisons list", () => {
  it("links each comparison to its own address and offers a new one", () => {
    render(<SavedComparisonsTable rows={ROWS} />)
    expect(
      screen.getByRole("link", { name: "Loaves" }).getAttribute("href")
    ).toBe("/recipes/compare/cmp_loaves")
    expect(screen.getByText("Country loaf, Brioche")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "New comparison" }).getAttribute("href")
    ).toBe("/recipes/compare/new")
  })

  it("removes a row only once the delete has landed", async () => {
    deleteComparison.mockResolvedValue({ ok: true })
    render(<SavedComparisonsTable rows={ROWS} />)
    fireEvent.click(screen.getByRole("button", { name: "Actions for Loaves" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete comparison" })
    )
    await waitFor(() => {
      expect(deleteComparison).toHaveBeenCalledWith("uuid-1")
    })
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Loaves" })).toBeNull()
    })
    expect(toastAdd).toHaveBeenCalledWith({ title: "Deleted Loaves" })
  })
})
