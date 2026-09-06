// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Commit } from "@/hooks/use-commit"

const {
  commits,
  resetIngredientConversion,
  saveIngredientConversion,
  savePurchaseUnit,
  costSaveRef,
  setCostDirty,
  toastAdd,
  removePreparations,
} = vi.hoisted(() => ({
  commits: [] as Commit[],
  resetIngredientConversion: vi.fn(),
  saveIngredientConversion: vi.fn(),
  savePurchaseUnit: vi.fn(),
  costSaveRef: { current: null as (() => Promise<unknown>) | null },
  setCostDirty: vi.fn(),
  toastAdd: vi.fn(),
  removePreparations: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "imperial",
  }),
}))

vi.mock("@/components/ingredients/ingredient-chrome", () => ({
  useIngredientEdit: () => ({
    addPreparation: vi.fn(),
    editPreparation: vi.fn(),
    removePreparations,
    purchaseUnit: null,
    savePurchaseUnit,
    saveRef: costSaveRef,
    setDirty: setCostDirty,
    commit: async (entry: Commit) => {
      commits.push(entry)
      entry.apply()
      await entry.write()
      return null
    },
  }),
  useIngredientFormBinding: () => ({
    saveRef: { current: null },
    actions: false,
    onDirtyChange: vi.fn(),
    onSaveStateChange: vi.fn(),
    purchaseUnit: null,
  }),
  useIngredientTabSave: vi.fn(),
}))

vi.mock("@/components/ingredients/ingredient-form", () => ({
  IngredientForm: ({
    children,
    sidebar,
    nonEdible,
  }: {
    children?: React.ReactNode
    sidebar?: React.ReactNode
    nonEdible?: boolean
  }) => (
    <div data-non-edible={String(Boolean(nonEdible))}>
      <label htmlFor="name">Name</label>
      <input id="name" />
      <label htmlFor="tags">Tags</label>
      <input id="tags" />
      {children}
      {sidebar}
    </div>
  ),
}))

vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...props
  }: {
    href: string
    children?: React.ReactNode
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  replaceIngredientAllergens: vi.fn(),
  saveIngredientConversion,
  resetIngredientConversion,
}))

import {
  IngredientCostPanel,
  IngredientPanel,
  NewIngredientPanel,
} from "@/components/ingredients/ingredient-panels"
import { PurchaseUnitDialog } from "@/components/ingredients/purchase-unit-dialog"

const ingredient = {
  id: "ing-1",
  name: "Eggs",
  purchaseCostCents: 0,
  purchaseSize: null,
  purchaseUnit: null,
  yieldPercent: 100,
  priceSource: "user" as const,
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
  tags: [],
  preparations: [],
  priceHistory: [],
  usedInRecipes: [],
  usedInProducts: [],
} as never

const connectedUnpricedIngredient = {
  ...(ingredient as object),
  supplierItems: [
    {
      id: "supplier-1",
      supplier: "acme",
      externalId: "damilk8",
      title: "Heavy Cream 40%",
      rawSize: "",
      packPriceCents: 0,
      packGrams: 0,
      packAmount: 1,
      packUnit: "each",
      purchasedQuantity: null,
      periodStart: null,
      periodEnd: null,
      isPreferred: true,
      updatedAt: new Date("2026-08-24T21:11:43Z"),
    },
  ],
  invoicePrices: [
    {
      id: "price-1",
      lineId: "line-1",
      supplier: "Acme",
      title: "Heavy Cream 40%",
      externalId: "damilk8",
      rawSize: "1 EA",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "each",
      currencyCode: "USD",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-08-24",
      isUsedForCosting: false,
      createdAt: new Date("2026-08-24T21:11:43Z"),
      updatedAt: new Date("2026-08-24T21:11:43Z"),
    },
  ],
} as never

const pricedIngredient = {
  ...(ingredient as object),
  purchaseCostCents: 4660,
  purchaseSize: 180,
  purchaseUnit: "each",
} as never

/** A supply: bought, stored and used in one unit. */
const supply = {
  ...(ingredient as object),
  nonEdible: true,
} as never

/** A supply the menu sells: products, never recipes, are what use it. */
const supplyInProducts = {
  ...(supply as object),
  usedInProducts: [
    {
      id: "p1",
      publicId: "prd_1",
      name: "Iced latte",
      isActive: true,
      quantity: 1,
      unit: "each",
    },
    {
      id: "p2",
      publicId: "prd_2",
      name: "Retired cold brew",
      isActive: false,
      quantity: 2,
      unit: "",
    },
  ],
} as never

/** Measured by hand, so the row is no longer on the standard conversion. */
const customConversionIngredient = {
  ...(ingredient as object),
  conversion: {
    usesStandardConversion: false,
    source: "user",
    confidence: "high",
    weight: { amount: 50, unit: "g" },
    volume: null,
    each: null,
  },
} as never

/** Copied from the catalog and never edited: a shared estimate. */
const catalogConversionIngredient = {
  ...(ingredient as object),
  conversion: {
    usesStandardConversion: false,
    source: "catalog",
    confidence: "low",
    weight: { amount: 237, unit: "g" },
    volume: { amount: 1, unit: "cup" },
    each: null,
  },
} as never

afterEach(() => {
  cleanup()
  savePurchaseUnit.mockReset()
  saveIngredientConversion.mockReset()
  resetIngredientConversion.mockReset()
  setCostDirty.mockReset()
  toastAdd.mockReset()
  costSaveRef.current = null
  commits.length = 0
})

describe("ingredient profile layouts", () => {
  it.each([
    ["new", () => <NewIngredientPanel availableTags={[]} />],
    [
      "saved",
      () => <IngredientPanel ingredient={ingredient} availableTags={[]} />,
    ],
  ])("shows the shared profile sections on the %s screen", (_name, view) => {
    render(view())

    expect(screen.getByLabelText("Name")).not.toBeNull()
    expect(screen.getByLabelText("Tags")).not.toBeNull()
    expect(screen.getByRole("heading", { name: "Preparations" })).not.toBeNull()
    expect(screen.getByText("UOM")).not.toBeNull()
    expect(screen.getByLabelText("Weight amount")).not.toBeNull()
    expect(screen.getByLabelText("Volume amount")).not.toBeNull()
    expect(
      screen.getByLabelText("Each amount").getAttribute("placeholder")
    ).toBe("–")
    // No switch gates these: a saved ingredient's measurements are always
    // typeable, and typing is what moves it off the standard conversion.
    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).disabled
    ).toBe(_name === "new")
    expect(screen.queryByRole("heading", { name: "Cost" })).toBeNull()
    expect(screen.queryByLabelText("Cost (USD)")).toBeNull()
    expect(screen.queryByRole("button", { name: "Purchase unit" })).toBeNull()
    // Reset to default is the menu's only action, so on an ingredient that
    // is already on the default there is nothing behind the button.
    expect(
      (
        screen.getByRole("button", {
          name: "UOM actions",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    const addButton = screen.getByRole("button", { name: "+ Add" })
    expect((addButton as HTMLButtonElement).disabled).toBe(_name === "new")
    // The saved screen has one divider more: nothing uses an ingredient
    // that has not been created yet, so it carries no Used in section.
    expect(screen.getAllByRole("separator")).toHaveLength(
      _name === "saved" ? 2 : 1
    )
  })

  it.each([
    ["new", () => <NewIngredientPanel availableTags={[]} nonEdible />],
    ["saved", () => <IngredientPanel ingredient={supply} availableTags={[]} />],
  ])("leaves the food-only sections off the %s supply", (_name, view) => {
    render(view())

    expect(screen.getByLabelText("Name")).not.toBeNull()
    expect(screen.queryByRole("heading", { name: "Preparations" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "UOM" })).toBeNull()
    expect(screen.queryByLabelText("Weight amount")).toBeNull()
    // One divider, between the profile fields and the folded-in Cost.
    expect(screen.queryAllByRole("separator")).toHaveLength(1)
    // The Cost tab's fields, folded into the one page a supply has.
    expect(screen.getByRole("heading", { name: "Cost" })).not.toBeNull()
    expect(screen.getByLabelText("Cost (USD)")).not.toBeNull()
    expect(screen.getByLabelText("Size")).not.toBeNull()
    expect(screen.getByLabelText("Yield")).not.toBeNull()
    if (_name === "saved") {
      expect(screen.getByRole("heading", { name: "Used in" })).not.toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Actions" }))
      expect(screen.getByText("Price history")).not.toBeNull()
    } else {
      // Nothing is saved yet, so there is no history to offer.
      expect(screen.queryByRole("button", { name: "Actions" })).toBeNull()
    }
  })

  it("points a supply's Used in at the products holding it", () => {
    render(<IngredientPanel ingredient={supplyInProducts} availableTags={[]} />)

    const section = within(
      screen.getByRole("heading", { name: "Used in" }).closest("section")!
    )
    expect(
      section.getByRole("link", { name: /Iced latte/ }).getAttribute("href")
    ).toBe("/products/prd_1")
    expect(section.getByText("1 each")).not.toBeNull()
    // An inactive product still counts; it is just not on the menu.
    expect(section.getByText("Inactive")).not.toBeNull()
  })

  it("asks a supply for products and food for recipes when nothing uses it", () => {
    render(<IngredientPanel ingredient={supply} availableTags={[]} />)
    expect(screen.getByText("No product uses this yet.")).not.toBeNull()
    expect(screen.queryByText("No recipe uses this yet.")).toBeNull()

    cleanup()
    render(<IngredientPanel ingredient={ingredient} availableTags={[]} />)
    expect(screen.getByText("No recipe uses this yet.")).not.toBeNull()
  })

  it("leaves the header's Save to the form on a supply's one page", () => {
    render(<IngredientPanel ingredient={supply} availableTags={[]} />)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "12.00" },
    })

    // The embedded section claims neither the header's Save nor its dirty
    // flag; a complete pack still writes itself on blur.
    expect(costSaveRef.current).toBeNull()
    expect(setCostDirty).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Size"), {
      target: { value: "10 lb" },
    })
    fireEvent.blur(screen.getByLabelText("Size"))

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ cost: "12.00", size: "10", unit: "lb" })
    )
  })

  it("stashes a new supply's pack for the form's own save", () => {
    render(<NewIngredientPanel availableTags={[]} nonEdible />)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "8.00" },
    })
    fireEvent.blur(screen.getByLabelText("Cost (USD)"))

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ cost: "8.00" })
    )
    // Nothing to sync against before the supply exists.
    expect(screen.queryByLabelText("Invoice item")).toBeNull()
  })

  it("creates a supply in the one save when the screen asks for one", () => {
    const { container } = render(<NewIngredientPanel availableTags={[]} />)
    expect(container.querySelector("[data-non-edible=true]")).toBeNull()

    cleanup()
    const supply = render(<NewIngredientPanel availableTags={[]} nonEdible />)
    expect(
      supply.container.querySelector("[data-non-edible=true]")
    ).not.toBeNull()
  })

  it("confirms a preparation delete and lists the recipes that refuse it", async () => {
    removePreparations.mockResolvedValue({
      error: "This preparation is used in recipes.",
      usedInRecipes: [{ id: "r1", publicId: "rcp_1", title: "Soup" }],
    })
    render(
      <IngredientPanel
        ingredient={
          {
            ...(ingredient as object),
            preparations: [
              {
                id: "prep-1",
                name: "Diced",
                yieldPercent: 90,
                usesStandardConversion: true,
                weight: null,
                volume: null,
                each: null,
              },
            ],
          } as never
        }
        availableTags={[]}
      />
    )

    fireEvent.click(screen.getByLabelText("Actions for Diced"))
    fireEvent.click(screen.getByText("Delete"))
    // Nothing is written until the dialog is confirmed.
    expect(removePreparations).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Delete preparation"))
    await waitFor(() =>
      expect(screen.getByText("Soup", { selector: "span" })).not.toBeNull()
    )
    expect(removePreparations).toHaveBeenCalledWith(["prep-1"])
  })

  it("puts purchase details and price history on the Cost tab", () => {
    render(<IngredientCostPanel ingredient={ingredient} />)

    expect(screen.getByRole("heading", { name: "Cost" })).not.toBeNull()
    expect(screen.getByLabelText("Cost (USD)")).not.toBeNull()
    expect(screen.getByLabelText("Size")).not.toBeNull()
    expect(screen.getByLabelText("Size").getAttribute("placeholder")).toBe("–")
    expect(screen.getByText("Invoice prices")).not.toBeNull()
    expect(screen.getByText("No invoice prices connected yet.")).not.toBeNull()
    expect(screen.getByLabelText("Invoice item")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    expect(screen.getByText("Price history")).not.toBeNull()
  })

  it("labels a conversion the catalog supplied as an estimate", () => {
    render(
      <IngredientPanel
        ingredient={catalogConversionIngredient}
        availableTags={[]}
      />
    )
    expect(screen.getByText("Estimate")).not.toBeNull()

    cleanup()
    render(
      <IngredientPanel
        ingredient={customConversionIngredient}
        availableTags={[]}
      />
    )
    expect(screen.queryByText("Estimate")).toBeNull()
  })

  it("confirms before resetting a UOM", async () => {
    resetIngredientConversion.mockResolvedValue({ ok: true })
    render(
      <IngredientPanel
        ingredient={customConversionIngredient}
        availableTags={[]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "UOM actions" }))
    fireEvent.click(await screen.findByText("Reset to default"))

    expect(screen.getByRole("heading", { name: "Reset UOM?" })).not.toBeNull()
    expect(resetIngredientConversion).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(resetIngredientConversion).toHaveBeenCalledOnce()
  })

  it("puts a refused conversion back to the one that landed, not the prop", async () => {
    saveIngredientConversion.mockResolvedValue({ ok: true })
    render(
      <IngredientPanel
        ingredient={catalogConversionIngredient}
        availableTags={[]}
      />
    )

    const weight = screen.getByLabelText("Weight amount") as HTMLInputElement
    fireEvent.change(weight, { target: { value: "300" } })
    fireEvent.blur(weight)
    await waitFor(() => expect(commits).toHaveLength(1))

    const volume = screen.getByLabelText("Volume amount") as HTMLInputElement
    fireEvent.change(volume, { target: { value: "2" } })
    fireEvent.blur(volume)
    await waitFor(() => expect(commits).toHaveLength(2))

    // The refresh behind the first write has not landed, so the prop still
    // reads 237; the revert must not reach back past what the server took.
    act(() => commits[1].revert())
    expect(weight.value).toBe("300")
    expect(volume.value).toBe("1")
  })

  it("reverts to what the in-flight write is sending, not the older state", async () => {
    let release: () => void = () => {}
    saveIngredientConversion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        })
    )
    saveIngredientConversion.mockResolvedValue({ ok: true })
    render(
      <IngredientPanel
        ingredient={catalogConversionIngredient}
        availableTags={[]}
      />
    )

    const weight = screen.getByLabelText("Weight amount") as HTMLInputElement
    fireEvent.change(weight, { target: { value: "300" } })
    fireEvent.blur(weight)
    await waitFor(() => expect(commits).toHaveLength(1))

    const volume = screen.getByLabelText("Volume amount") as HTMLInputElement
    fireEvent.change(volume, { target: { value: "2" } })
    fireEvent.blur(volume)
    await waitFor(() => expect(commits).toHaveLength(2))

    act(() => commits[1].revert())
    expect(weight.value).toBe("300")
    expect(volume.value).toBe("1")
    release()
  })

  it("splits a unit typed into the amount into the dropdown beside it", () => {
    render(<IngredientCostPanel ingredient={ingredient} />)

    const size = screen.getByLabelText("Size") as HTMLInputElement
    fireEvent.change(size, { target: { value: "16lb" } })
    fireEvent.blur(size)

    expect(size.value).toBe("16")
    expect(screen.getByLabelText("Size unit").textContent).toContain("lb")
  })

  it("saves an edited yield on blur, the way the cost and size do", () => {
    render(<IngredientCostPanel ingredient={ingredient} />)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "10.00" },
    })
    fireEvent.change(screen.getByLabelText("Size"), {
      target: { value: "10 lb" },
    })

    const field = screen.getByLabelText("Yield") as HTMLInputElement
    expect(field.value).toBe("100")
    fireEvent.change(field, { target: { value: "90" } })
    // Typing alone writes nothing; the Cost section saves as the field leaves.
    expect(savePurchaseUnit).not.toHaveBeenCalled()

    fireEvent.blur(field)

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ yieldPercent: "90", unit: "lb" })
    )
  })

  it("hands an unblurred cost edit to the header Save", async () => {
    savePurchaseUnit.mockResolvedValue(null)
    render(<IngredientCostPanel ingredient={pricedIngredient} />)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "47.00" },
    })
    expect(setCostDirty).toHaveBeenLastCalledWith(true)

    await act(async () => {
      await costSaveRef.current?.()
    })

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ cost: "47.00", size: "180", unit: "each" })
    )
    expect(setCostDirty).toHaveBeenLastCalledWith(false)
  })

  it("hands a first cost to the header Save before a unit is chosen", async () => {
    savePurchaseUnit.mockResolvedValue({
      kind: "validation",
      message: "Add a cost and a unit first.",
    })
    render(<IngredientCostPanel ingredient={ingredient} />)
    expect(setCostDirty).toHaveBeenLastCalledWith(false)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "12.00" },
    })

    await act(async () => {
      await costSaveRef.current?.()
    })

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ cost: "12.00" })
    )
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Add a cost and a unit first.",
      type: "error",
    })
  })

  it("saves a disconnect even when the ingredient has no active price", () => {
    render(<IngredientCostPanel ingredient={connectedUnpricedIngredient} />)

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))

    expect(savePurchaseUnit).toHaveBeenCalledWith(
      expect.objectContaining({ disconnectInvoicePriceId: "price-1" })
    )
  })

  it("writes a cost typed after a disconnect", async () => {
    savePurchaseUnit.mockResolvedValue(null)
    render(<IngredientCostPanel ingredient={connectedUnpricedIngredient} />)

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    fireEvent.change(screen.getByLabelText("Size"), {
      target: { value: "5 lb" },
    })
    fireEvent.blur(screen.getByLabelText("Size"))
    const cost = screen.getByLabelText("Cost (USD)")
    fireEvent.change(cost, { target: { value: "12.00" } })
    fireEvent.blur(cost)

    await waitFor(() =>
      expect(savePurchaseUnit).toHaveBeenLastCalledWith(
        expect.objectContaining({ cost: "12.00", size: "5", unit: "lb" })
      )
    )
  })
})

/** The labelled fields inside `root`, in the order the markup renders them. */
function priceFields(root: HTMLElement) {
  return [...root.querySelectorAll("input")]
    .map(
      (input) =>
        root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent
    )
    .filter(Boolean)
}

describe("one Price form behind both screens", () => {
  it("asks the Cost tab and the Price dialog for the same fields", () => {
    render(<IngredientCostPanel ingredient={ingredient} />)
    const section = screen
      .getByRole("heading", { name: "Cost" })
      .closest("section") as HTMLElement
    const tab = priceFields(section)
    cleanup()

    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{ cost: "", size: "", unit: null, yieldPercent: "100" }}
        invoicePrices={[]}
        onSave={vi.fn()}
      />
    )

    expect(tab).toEqual(["Cost (USD)", "Size", "Yield", "Invoice item"])
    expect(priceFields(screen.getByRole("dialog"))).toEqual(tab)
  })
})
