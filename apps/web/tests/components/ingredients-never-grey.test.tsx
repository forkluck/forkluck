// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const { saveIngredient } = vi.hoisted(() => ({
  saveIngredient: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  saveIngredient,
  searchInvoiceItems: vi.fn(),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "imperial",
  }),
}))

import { IngredientForm } from "@/components/ingredients/ingredient-form"
import { PreparationDialog } from "@/components/ingredients/preparation-dialog"
import { PurchaseUnitDialog } from "@/components/ingredients/purchase-unit-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the ingredient form's Save button", () => {
  it("stays enabled with no name", () => {
    render(
      <IngredientForm
        initial={null}
        onDone={vi.fn()}
        saveRef={{ current: null }}
      />
    )
    expect(
      (
        screen.getByRole("button", {
          name: "Save ingredient",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("asks for a name instead of saving", () => {
    render(
      <IngredientForm
        initial={null}
        onDone={vi.fn()}
        saveRef={{ current: null }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))
    expect(saveIngredient).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter a name.")
  })

  it("saves once a name is typed", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-1",
      publicId: "ing_1",
      editVersion: 0,
    })
    render(
      <IngredientForm
        initial={null}
        onDone={vi.fn()}
        saveRef={{ current: null }}
      />
    )
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Butter" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))
    await vi.waitFor(() => expect(saveIngredient).toHaveBeenCalled())
  })
})

describe("the preparation dialog's Add button", () => {
  it("stays enabled with no name", () => {
    render(<PreparationDialog open onOpenChange={vi.fn()} onAdd={vi.fn()} />)
    expect(
      (
        screen.getByRole("button", {
          name: "Add preparation",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("asks for a name instead of adding", () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(<PreparationDialog open onOpenChange={vi.fn()} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole("button", { name: "Add preparation" }))
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter a name.")
  })

  it("adds once a name is typed", () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(<PreparationDialog open onOpenChange={vi.fn()} onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Diced" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add preparation" }))
    expect(onAdd).toHaveBeenCalled()
  })
})

describe("the purchase unit dialog's Save button", () => {
  const initial = { cost: "", size: "", unit: null, yieldPercent: "100" }

  it("stays enabled with no unit", () => {
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={initial}
        invoicePrices={[]}
        onSave={vi.fn().mockResolvedValue(null)}
      />
    )
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for a purchase unit instead of saving", () => {
    const onSave = vi.fn().mockResolvedValue(null)
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={initial}
        invoicePrices={[]}
        onSave={onSave}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Select a purchase unit."
    )
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Size unit" })
    )
  })

  it("saves once a unit is set", () => {
    const onSave = vi.fn().mockResolvedValue(null)
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{ cost: "10.00", size: "1", unit: "kg", yieldPercent: "100" }}
        invoicePrices={[]}
        onSave={onSave}
      />
    )
    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "12.00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalled()
  })
})
