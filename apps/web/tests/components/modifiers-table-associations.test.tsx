// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { saveSalesModifierAssociations } = vi.hoisted(() => ({
  saveSalesModifierAssociations: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/app/(app)/products/actions", () => ({
  saveSalesModifierAssociations,
}))

import { ModifiersTable } from "@/components/menu/modifiers-table"
import type { SalesModifierCatalogList } from "@/lib/backend/types"

const list: SalesModifierCatalogList = {
  id: "list-1",
  channel: "square",
  providerAccountId: "merchant",
  externalObjectId: "LIST",
  name: "Snack Flight",
  modifierType: "list",
  selectionType: "multiple",
  allowQuantities: false,
  minSelected: 1,
  maxSelected: 1,
  mappedCount: 1,
  options: [
    {
      id: "option-1",
      externalObjectId: "CURRENT-1",
      name: "Pineapple Linzer",
      ordinal: 1,
      priceCents: 0,
      currencyCode: "USD",
      variantId: "variant-1",
      productId: "product-1",
      productName: "Pineapple Linzer",
      quantityMultiplier: 1,
    },
    {
      id: "option-2",
      externalObjectId: "CURRENT-2",
      name: "Pineapple Linzer",
      ordinal: 2,
      priceCents: 0,
      currencyCode: "USD",
      variantId: null,
      productId: null,
      productName: null,
      quantityMultiplier: 1,
    },
  ],
  records: [],
}

function openDialog() {
  render(
    <ModifiersTable
      lists={[list]}
      unassignedRecords={[]}
      products={[]}
      squareConnected
      squareNeedsReconnect={false}
      squareSyncedAt="2026-08-13T11:00:00Z"
      squareSalesSyncedAt="2026-08-13T10:00:00Z"
    />
  )
  fireEvent.click(screen.getByText("Snack Flight"))
}

beforeEach(() => {
  saveSalesModifierAssociations.mockResolvedValue({ variantIds: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("saving modifier associations", () => {
  it("closes the dialog once the write lands", async () => {
    openDialog()

    fireEvent.click(screen.getByRole("button", { name: "Save associations" }))

    await waitFor(() =>
      expect(saveSalesModifierAssociations).toHaveBeenCalledTimes(1)
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps the dialog open with the message when the write is refused", async () => {
    saveSalesModifierAssociations.mockResolvedValue({
      error: "Square refused that.",
    })
    openDialog()

    fireEvent.click(screen.getByRole("button", { name: "Save associations" }))

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Square refused that."
    )
    expect(screen.getByRole("dialog")).not.toBeNull()
  })

  it("holds the dialog shut while the controller is writing", async () => {
    let land: (result: { variantIds: string[] }) => void = () => {}
    saveSalesModifierAssociations.mockReturnValue(
      new Promise((resolve) => {
        land = resolve
      })
    )
    openDialog()

    fireEvent.click(screen.getByRole("button", { name: "Save associations" }))

    const cancel = screen.getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(true))

    land({ variantIds: [] })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("lets the dialog go again once the write is refused", async () => {
    saveSalesModifierAssociations.mockResolvedValue({
      error: "Square refused that.",
    })
    openDialog()

    fireEvent.click(screen.getByRole("button", { name: "Save associations" }))
    await screen.findByRole("alert")

    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")
    ).toBe(false)
  })
})
