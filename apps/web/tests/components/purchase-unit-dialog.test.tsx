// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

const searchInvoiceItems = vi.fn()
const saveIngredient = vi.fn()
const linkInvoiceItem = vi.fn()
const disconnectInvoiceItem = vi.fn()
const applyInvoicePrice = vi.fn()
const deleteIngredient = vi.fn()
const routerPush = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchInvoiceItems: (query: string) => searchInvoiceItems(query),
  saveIngredient: (input: unknown) => saveIngredient(input),
  linkInvoiceItem: (...args: unknown[]) => linkInvoiceItem(...args),
  disconnectInvoiceItem: (...args: unknown[]) => disconnectInvoiceItem(...args),
  applyInvoicePrice: (...args: unknown[]) => applyInvoicePrice(...args),
  deleteIngredient: (id: string) => deleteIngredient(id),
  deletePreparations: vi.fn(),
  savePreparation: vi.fn(),
  saveIngredientConversion: vi.fn(),
}))

const toastAdd = vi.fn()

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({
    go: async (href: string) => {
      routerPush(href)
      return true
    },
    pending: false,
  }),
  useNavigationBlocker: () => ({
    setIsBlocked: vi.fn(),
    allowNavigation: vi.fn(),
  }),
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/ingredients/ing_1/ingredient",
  useRouter: () => ({ refresh: vi.fn(), push: routerPush }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "imperial",
  }),
}))

import * as React from "react"

import {
  IngredientChrome,
  useIngredientEdit,
} from "@/components/ingredients/ingredient-chrome"
import { PurchaseUnitDialog } from "@/components/ingredients/purchase-unit-dialog"
import type { IngredientRow, InvoiceLineOption } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  searchInvoiceItems.mockReset()
  saveIngredient.mockReset()
  linkInvoiceItem.mockReset()
  disconnectInvoiceItem.mockReset()
  applyInvoicePrice.mockReset()
  deleteIngredient.mockReset()
  routerPush.mockReset()
  toastAdd.mockReset()
  draftSubmit.mockReset()
})

/** Three cases at $24.50, printed by the vendor only as a line total. */
const threeCases: InvoiceLineOption = {
  id: "line-1",
  supplier: "Acme Produce",
  description: "CARROTS BABY ORANGE",
  sku: "CAR10",
  packSize: "25 LB",
  quantity: 3,
  unitPriceCents: null,
  lineAmountCents: 7350,
  currencyCode: "USD",
  invoiceDate: "2026-07-14",
  linkedIngredients: [],
}

/** The item an ingredient is already bought as, as the dialog reads it. */
const savedItem: IngredientRow["invoicePrices"][number] = {
  id: "item-1",
  lineId: "line-saved",
  supplier: "Sysco",
  externalId: "48213",
  title: "Butter unsalted 36/1lb",
  rawSize: "36/1 LB",
  purchaseCostCents: 12000,
  purchaseSize: 36,
  purchaseUnit: "lb",
  currencyCode: "USD",
  invoiceNumber: "INV-1",
  invoiceDate: "2026-08-03",
  isUsedForCosting: true,
  createdAt: new Date("2026-08-03T12:00:00Z"),
  updatedAt: new Date("2026-08-03T12:00:00Z"),
}

/** Types into the inline search and waits for the line to be listed. */
async function pickTheLine(item: InvoiceLineOption) {
  searchInvoiceItems.mockResolvedValue({ items: [item] })
  const onSave = vi.fn().mockResolvedValue(null)
  render(
    <PurchaseUnitDialog
      open
      onOpenChange={vi.fn()}
      initial={{ cost: "", size: "", unit: null, yieldPercent: "100" }}
      invoicePrices={[]}
      onSave={onSave}
    />
  )
  const search = screen.getByLabelText("Invoice item")
  fireEvent.change(search, { target: { value: "carrots" } })
  const option = await screen.findByRole("option", {
    name: /CARROTS BABY ORANGE/,
  })
  return { option, onSave, search }
}

describe("the fields the dialog asks for", () => {
  it("still asks for the pack and its invoice item after the fields moved out", () => {
    // The recipe Cost tab renders the same PurchaseUnitFields, so this pins
    // what both screens ask for rather than letting one of them drift.
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

    expect(
      (screen.getByLabelText("Cost (USD)") as HTMLInputElement).value
    ).toBe("10.00")
    // The amount holds the number; its unit is the dropdown beside it.
    expect((screen.getByLabelText("Size") as HTMLInputElement).value).toBe("1")
    expect(screen.getByLabelText("Size unit").textContent).toContain("kg")
    expect(screen.getByLabelText("Invoice item")).toBeTruthy()
    expect(screen.getByText("Invoice prices")).toBeTruthy()
    expect(screen.getByText("No invoice prices connected yet.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull()
    // The search sits in the form itself, not behind a second dialog.
    expect(screen.getAllByRole("dialog")).toHaveLength(1)

    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "11.00" },
    })
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })
    )
    expect(onSave).toHaveBeenCalledWith({
      cost: "11.00",
      size: "1",
      unit: "kg",
      yieldPercent: "100",
      invoiceLineId: null,
      disconnectInvoicePriceId: null,
      useInvoicePriceId: null,
    })
  })

  it("shows the saved yield and saves an edited one", () => {
    const onSave = vi.fn().mockResolvedValue(null)
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{
          cost: "10.00",
          size: "10",
          unit: "lb",
          yieldPercent: "90",
        }}
        invoicePrices={[]}
        onSave={onSave}
      />
    )

    const field = screen.getByLabelText("Yield") as HTMLInputElement
    expect(field.value).toBe("90")
    expect(field.placeholder).toBe("100")
    // What the number means is said once, beside the column it heads.
    expect(screen.getByRole("img", { name: "What Yield means" })).toBeTruthy()

    fireEvent.change(field, { target: { value: "85" } })
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })
    )
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ yieldPercent: "85" })
    )
  })
})

describe("the connected invoice item", () => {
  it("lists invoice prices separately from the active cost", () => {
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{ cost: "10.00", size: "1", unit: "kg", yieldPercent: "100" }}
        invoicePrices={[savedItem]}
        onSave={vi.fn().mockResolvedValue(null)}
      />
    )

    expect(screen.getByText("Butter unsalted 36/1lb")).toBeTruthy()
    expect(screen.getByText(/Sysco 48213/)).toBeTruthy()
    expect(screen.getByText("Used for costing")).toBeTruthy()
    // The search stays where it is, so the next item is one search away.
    expect(screen.getByLabelText("Invoice item")).toBeTruthy()
  })

  it("shows a picked line as a separate invoice-price draft", async () => {
    const { option } = await pickTheLine(threeCases)
    fireEvent.click(option)

    expect(await screen.findByText("CARROTS BABY ORANGE")).toBeTruthy()
    expect((screen.getByLabelText("Pack size") as HTMLInputElement).value).toBe(
      "25"
    )
    expect(screen.getByLabelText("Pack unit").textContent).toContain("lb")
    expect(
      (screen.getByLabelText("Cost (USD)") as HTMLInputElement).value
    ).toBe("")
  })

  it("drops the line when the item is disconnected", () => {
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{ cost: "10.00", size: "1", unit: "kg", yieldPercent: "100" }}
        invoicePrices={[savedItem]}
        onSave={vi.fn().mockResolvedValue(null)}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))

    expect(screen.queryByText("Butter unsalted 36/1lb")).toBeNull()
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull()
    // The search is still there, ready for another item.
    expect(screen.getByLabelText("Invoice item")).toBeTruthy()
  })
})

describe("connecting an invoice line without a unit price", () => {
  it("prefills the invoice pack without replacing the ingredient cost", async () => {
    // A quantity of 3 against a $73.50 line total is $24.50 a pack. Saving the
    // line total would cost every recipe using this ingredient at triple.
    const { option } = await pickTheLine(threeCases)
    fireEvent.click(option)

    expect(
      (screen.getByLabelText("Cost (USD)") as HTMLInputElement).value
    ).toBe("")
    expect((screen.getByLabelText("Pack size") as HTMLInputElement).value).toBe(
      "25"
    )
    expect(screen.getByLabelText("Pack unit").textContent).toContain("lb")
  })

  it("prices the picker row per pack too", async () => {
    await pickTheLine(threeCases)

    expect(await screen.findByText("$24.50")).toBeTruthy()
  })

  it("says which lines are already connected to an ingredient", async () => {
    // Existing links are informational; the same purchase can price another
    // ingredient such as Egg and Egg yolk.
    const { option } = await pickTheLine({
      ...threeCases,
      linkedIngredients: [
        {
          name: "Rainbow carrots",
          publicId: "ing_rainbow",
        },
      ],
    })

    expect(await screen.findByLabelText("Used by Rainbow carrots")).toBeTruthy()
    fireEvent.click(option)

    expect(screen.getByRole("button", { name: "Add price" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("re-picks the item this ingredient is already connected to", async () => {
    // The backend allows a relink onto the same ingredient, so a newer invoice
    // line for its own SKU has to price it rather than be refused.
    const line = {
      ...threeCases,
      linkedIngredients: [{ name: "Baby carrots", publicId: "ing_carrots" }],
    }
    searchInvoiceItems.mockResolvedValue({ items: [line] })
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={vi.fn()}
        initial={{ cost: "", size: "", unit: null, yieldPercent: "100" }}
        invoicePrices={[]}
        onSave={vi.fn().mockResolvedValue(null)}
      />
    )
    fireEvent.change(screen.getByLabelText("Invoice item"), {
      target: { value: "carrots" },
    })
    fireEvent.click(
      await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    )

    expect(screen.getByRole("button", { name: "Add price" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

/** The Price form on its own, with whatever item is already connected. */
function renderPriceForm(
  invoicePrices: IngredientRow["invoicePrices"] = [],
  onSave = vi.fn().mockResolvedValue(null)
) {
  render(
    <PurchaseUnitDialog
      open
      onOpenChange={vi.fn()}
      initial={{ cost: "", size: "", unit: null, yieldPercent: "100" }}
      invoicePrices={invoicePrices}
      onSave={onSave}
    />
  )
  return { onSave }
}

/** A second line, so a query has something to leave out. */
const butter: InvoiceLineOption = {
  id: "line-2",
  supplier: "Sysco",
  description: "BUTTER UNSALTED",
  sku: "BUT20",
  packSize: "1 kg",
  quantity: 1,
  unitPriceCents: 990,
  lineAmountCents: 990,
  currencyCode: "USD",
  invoiceDate: "2026-07-02",
  linkedIngredients: [],
}

describe("the inline invoice item search", () => {
  it("lists nothing until a second character asks for it", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [threeCases] })
    renderPriceForm()

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "c" } })

    expect(searchInvoiceItems).not.toHaveBeenCalled()
    expect(screen.queryByRole("listbox")).toBeNull()

    fireEvent.change(search, { target: { value: "ca" } })

    expect(
      await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    ).toBeTruthy()
    expect(searchInvoiceItems).toHaveBeenCalledWith("ca")
  })

  it("lists what the typed word matches", async () => {
    searchInvoiceItems.mockImplementation((query: string) =>
      Promise.resolve({
        items: [threeCases, butter].filter((item) =>
          item.description.toLowerCase().includes(query.toLowerCase())
        ),
      })
    )
    renderPriceForm()

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "butter" } })

    expect(
      await screen.findByRole("option", { name: /BUTTER UNSALTED/ })
    ).toBeTruthy()
    expect(screen.queryByRole("option", { name: /CARROTS/ })).toBeNull()
  })

  it("picks the highlighted line with Enter and fills the invoice pack", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [threeCases] })
    const { onSave } = renderPriceForm()

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "carrots" } })
    await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(
      (screen.getByLabelText("Cost (USD)") as HTMLInputElement).value
    ).toBe("")
    expect((screen.getByLabelText("Pack size") as HTMLInputElement).value).toBe(
      "25"
    )
    expect(screen.getByLabelText("Pack unit").textContent).toContain("lb")

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })
    )
    // The unit reads off the pack size the same way clicking the row does.
    expect(onSave).toHaveBeenCalledWith({
      cost: "",
      size: "",
      unit: null,
      yieldPercent: "100",
      invoiceLineId: "line-1",
      invoicePurchaseSize: "25",
      invoicePurchaseUnit: "lb",
      disconnectInvoicePriceId: null,
      useInvoicePriceId: null,
    })
  })

  it("closes the list on Escape and leaves the Price dialog open", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [threeCases] })
    const onOpenChange = vi.fn()
    render(
      <PurchaseUnitDialog
        open
        onOpenChange={onOpenChange}
        initial={{ cost: "", size: "", unit: null, yieldPercent: "100" }}
        invoicePrices={[]}
        onSave={vi.fn().mockResolvedValue(null)}
      />
    )

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "carrots" } })
    await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    fireEvent.keyDown(search, { key: "Escape" })

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByLabelText("Invoice item")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("closes the list when the field is left", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [threeCases] })
    renderPriceForm()

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "carrots" } })
    await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    fireEvent.blur(search)

    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("adds another invoice price without replacing the connected one", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [threeCases] })
    const { onSave } = renderPriceForm([savedItem])

    const search = screen.getByLabelText("Invoice item")
    fireEvent.change(search, { target: { value: "carrots" } })
    fireEvent.click(
      await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
    )

    expect(screen.getByText("Butter unsalted 36/1lb")).toBeTruthy()
    expect(screen.getByText("CARROTS BABY ORANGE")).toBeTruthy()

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })
    )
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceLineId: "line-1",
        invoicePurchaseSize: "25",
        invoicePurchaseUnit: "lb",
      })
    )
  })

  it("says so when a search matches nothing", async () => {
    searchInvoiceItems.mockResolvedValue({ items: [] })
    renderPriceForm()

    fireEvent.change(screen.getByLabelText("Invoice item"), {
      target: { value: "zzz" },
    })

    expect(await screen.findByText("No matching invoice items")).toBeTruthy()
  })
})

/** Opens the purchase dialog the way the ingredient screen's own row does. */
function OpenPurchaseUnit() {
  const { editPurchaseUnit } = useIngredientEdit()
  return (
    <button
      type="button"
      onClick={() =>
        editPurchaseUnit({
          cost: "10.00",
          size: "1",
          unit: "kg",
          yieldPercent: "100",
        })
      }
    >
      Edit purchase
    </button>
  )
}

function OpenUnpricedPurchaseUnit() {
  const { editPurchaseUnit } = useIngredientEdit()
  return (
    <button
      type="button"
      onClick={() =>
        editPurchaseUnit({
          cost: "",
          size: "",
          unit: null,
          yieldPercent: "100",
        })
      }
    >
      Edit unpriced purchase
    </button>
  )
}

const draftSubmit = vi.fn()

/** Registers a save with the chrome the way the ingredient form does. */
function DraftIngredientForm() {
  const { saveRef } = useIngredientEdit()
  React.useEffect(() => {
    saveRef.current = async () => draftSubmit()
    return () => {
      saveRef.current = null
    }
  }, [saveRef])
  return null
}

describe("draft purchase details on a new ingredient", () => {
  it("marks the page dirty and lets the header save the draft", async () => {
    render(
      <IngredientChrome name="New ingredient">
        <OpenPurchaseUnit />
        <DraftIngredientForm />
      </IngredientChrome>
    )

    expect(
      screen
        .getByRole("link", { name: "Ingredient" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    expect(
      screen.getByRole("link", { name: "Cost" }).getAttribute("aria-disabled")
    ).toBe("true")
    expect(
      screen
        .getByRole("link", { name: "Nutrition" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    expect(
      (screen.getByRole("button", { name: "Actions" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Edit purchase" }))
    const dialog = screen.getByRole("dialog")
    expect(screen.queryByLabelText("Invoice item")).toBeNull()
    fireEvent.change(screen.getByLabelText("Cost (USD)"), {
      target: { value: "12.00" },
    })
    // The dialog closes on the save that landed, so the header is reachable.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    })

    const headerSave = screen.getByRole("button", { name: "Save" })
    expect((headerSave as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      fireEvent.click(headerSave)
    })
    expect(draftSubmit).toHaveBeenCalledTimes(1)
  })
})

describe("saved ingredient chrome", () => {
  it("disconnects an invoice item without requiring an active price", async () => {
    disconnectInvoiceItem.mockResolvedValue({ ok: true })
    render(
      <IngredientChrome
        id="ing-1"
        name="Heavy cream"
        publicId="ing_1"
        invoicePrices={[savedItem]}
      >
        <OpenUnpricedPurchaseUnit />
      </IngredientChrome>
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Edit unpriced purchase" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })
    )

    await waitFor(() =>
      expect(disconnectInvoiceItem).toHaveBeenCalledWith("ing-1", "item-1")
    )
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("opens the Nutrition tab and keeps actions enabled", () => {
    render(
      <IngredientChrome id="ing-1" name="Carrots" publicId="ing_1">
        <DraftIngredientForm />
      </IngredientChrome>
    )

    expect(screen.getByText("Ingredient")).not.toBeNull()
    // A live tab links out; a draft's tab is a disabled link instead.
    const cost = screen.getByRole("link", { name: "Cost" })
    expect(cost.getAttribute("href")).toBe("/ingredients/ing_1/cost")
    expect(cost.getAttribute("aria-disabled")).toBeNull()
    const nutrition = screen.getByRole("link", { name: "Nutrition" })
    expect(nutrition.getAttribute("href")).toBe("/ingredients/ing_1/nutrition")
    expect(nutrition.getAttribute("aria-disabled")).toBeNull()
    expect(
      (screen.getByRole("button", { name: "Actions" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("checks recipe usage only after the destructive confirmation", async () => {
    deleteIngredient.mockResolvedValue({
      error: "This ingredient is used in recipes.",
      usedInRecipes: [
        { id: "recipe-1", publicId: "rcp_1", title: "Carrot soup" },
      ],
    })
    render(
      <IngredientChrome id="ing-1" name="Carrots" publicId="ing_1">
        <DraftIngredientForm />
      </IngredientChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete ingredient" }))

    expect(deleteIngredient).not.toHaveBeenCalled()
    const dialog = screen.getByRole("dialog")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete ingredient" })
    )

    expect(
      await within(dialog).findByText(/can’t be deleted because it is used/)
    ).not.toBeNull()
    expect(
      within(dialog)
        .getByRole("link", { name: "Carrot soup" })
        .getAttribute("href")
    ).toBe("/recipes/rcp_1")
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Delete ingredient",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("deletes and leaves the page when no recipe uses the ingredient", async () => {
    deleteIngredient.mockResolvedValue({ ok: true })
    render(
      <IngredientChrome id="ing-1" name="Carrots" publicId="ing_1">
        <DraftIngredientForm />
      </IngredientChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete ingredient" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete ingredient",
      })
    )

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/ingredients"))
  })
})

async function connectAndSave(line: InvoiceLineOption) {
  searchInvoiceItems.mockResolvedValue({ items: [line] })
  render(
    <IngredientChrome id="ing-1" name="Carrots" publicId="ing_1">
      <OpenPurchaseUnit />
    </IngredientChrome>
  )
  fireEvent.click(screen.getByRole("button", { name: "Edit purchase" }))
  fireEvent.change(screen.getByLabelText("Invoice item"), {
    target: { value: "carrots" },
  })
  fireEvent.click(
    await screen.findByRole("option", { name: /CARROTS BABY ORANGE/ })
  )
  const dialog = screen.getByRole("dialog")
  expect((screen.getByLabelText("Cost (USD)") as HTMLInputElement).value).toBe(
    "10.00"
  )
  expect((screen.getByLabelText("Pack size") as HTMLInputElement).value).toBe(
    "25"
  )
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
}

describe("saving a purchase unit against an invoice item", () => {
  it("keeps the dialog open when adding the invoice price is refused", async () => {
    linkInvoiceItem.mockResolvedValue({
      error: "That invoice price could not be added.",
    })
    saveIngredient.mockResolvedValue({ id: "ing-1", publicId: "ing_1" })

    await connectAndSave(threeCases)

    // The dialog keeps the pack on screen and says why it did not land.
    expect((await screen.findByRole("alert")).textContent).toContain(
      "That invoice price could not be added."
    )
    expect(screen.getByRole("dialog")).not.toBeNull()
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("does not send the active ingredient cost with the invoice link", async () => {
    linkInvoiceItem.mockResolvedValue({ ok: true })
    saveIngredient.mockResolvedValue({ error: "That input is invalid." })

    await connectAndSave(threeCases)

    await waitFor(() => expect(linkInvoiceItem).toHaveBeenCalled())
    expect(linkInvoiceItem).toHaveBeenCalledWith("ing-1", "line-1", {
      purchaseSize: 25,
      purchaseUnit: "lb",
    })
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("connects the invoice price in one call", async () => {
    linkInvoiceItem.mockResolvedValue({ ok: true })

    await connectAndSave(threeCases)

    await waitFor(() => expect(linkInvoiceItem).toHaveBeenCalled())
    expect(linkInvoiceItem).toHaveBeenCalledWith("ing-1", "line-1", {
      purchaseSize: 25,
      purchaseUnit: "lb",
    })
    expect(saveIngredient).not.toHaveBeenCalled()
  })
})
