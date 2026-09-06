// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const searchCatalogPrices = vi.fn()
const searchInvoiceItems = vi.fn()
const saveRecipeLineMatch = vi.fn()
const saveIngredient = vi.fn()
const linkInvoiceItem = vi.fn()
const disconnectInvoiceItem = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  adoptCatalogPrice: vi.fn(),
  adoptMasterPrice: vi.fn(),
  dismissMasterPrice: vi.fn(),
  saveRecipeLineMatch: (...args: unknown[]) => saveRecipeLineMatch(...args),
  saveIngredient: (input: unknown) => saveIngredient(input),
  linkInvoiceItem: (...args: unknown[]) => linkInvoiceItem(...args),
  disconnectInvoiceItem: (id: string) => disconnectInvoiceItem(id),
  searchCatalogPrices: (query: string) => searchCatalogPrices(query),
  searchInvoiceItems: (query: string) => searchInvoiceItems(query),
}))

import { PriceLineDialog } from "@/components/ingredients/price-line-dialog"
import type { PriceListEntry } from "@/lib/pricing"

afterEach(() => {
  cleanup()
  searchCatalogPrices.mockReset()
  searchInvoiceItems.mockReset()
  saveRecipeLineMatch.mockReset()
  saveIngredient.mockReset()
  linkInvoiceItem.mockReset()
  disconnectInvoiceItem.mockReset()
})

describe("price line dialog catalog search", () => {
  it("clears a failed search's error once a retry succeeds", async () => {
    searchCatalogPrices
      .mockResolvedValueOnce({ error: "Catalog is unavailable" })
      .mockResolvedValueOnce({
        items: [
          {
            id: "catalog-flour",
            name: "Bread Flour",
            normalizedName: "bread flour",
            purchaseCostCents: 500,
            packGrams: 1000,
            source: "catalog",
            catalogPriceId: "catalog-price-1",
          },
        ],
      })

    render(
      <PriceLineDialog
        lineName="Bread Flour"
        priceList={[]}
        open
        trigger={null}
      />
    )

    const alert = await screen.findByRole("alert", {}, { timeout: 3000 })
    expect(alert.textContent).toBe("Catalog is unavailable")

    fireEvent.change(screen.getByLabelText("Search pricing choices"), {
      target: { value: "bread flour" },
    })

    await waitFor(() => expect(screen.getByText("Bread Flour")).toBeTruthy(), {
      timeout: 3000,
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stops searching after the quota error instead of extending the outage", async () => {
    searchCatalogPrices.mockReset()
    searchCatalogPrices.mockResolvedValue({
      error: "Too many Catalog requests. Wait a minute and try again.",
    })

    render(
      <PriceLineDialog
        lineName="Bread Flour"
        priceList={[]}
        open
        trigger={null}
      />
    )

    await screen.findByRole("alert", {}, { timeout: 3000 })
    expect(searchCatalogPrices).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText("Search pricing choices"), {
      target: { value: "bread flour again" },
    })
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(searchCatalogPrices).toHaveBeenCalledTimes(1)
  })
})

/** A pantry ingredient nobody has said what they buy it as. */
const unpricedZest: PriceListEntry = {
  id: "ing-zest",
  name: "Lemon zest",
  normalizedName: "lemon zest",
  purchaseCostCents: 0,
  purchaseSize: null,
  purchaseUnit: null,
  source: "pantry",
}

const pricedZest: PriceListEntry = {
  ...unpricedZest,
  purchaseCostCents: 500,
  purchaseSize: 1,
  purchaseUnit: "kg",
}

function openPicker(entry: PriceListEntry | null, onLinked = vi.fn()) {
  searchCatalogPrices.mockResolvedValue({ items: [] })
  render(
    <PriceLineDialog
      lineName="Lemon zest"
      priceList={entry ? [entry] : []}
      onLinked={onLinked}
      open
      trigger={null}
    />
  )
  return onLinked
}

/** Fills the shared purchase fields the way a cook would: size and unit as
 *  one phrase, the way the Ingredients tab asks for them. */
function fillPurchase({ cost, size }: { cost: string; size: string }) {
  fireEvent.change(screen.getByLabelText("Cost (USD)"), {
    target: { value: cost },
  })
  fireEvent.change(screen.getByLabelText("Size"), { target: { value: size } })
}

describe("pricing a pantry row from the recipe cost tab", () => {
  it("asks what an unpriced ingredient is bought as, then links the line", async () => {
    saveIngredient.mockResolvedValue({ id: "ing-zest", publicId: "ing_zest" })
    saveRecipeLineMatch.mockResolvedValue({ ok: true })
    const onLinked = openPicker(unpricedZest)

    fireEvent.click(screen.getByRole("button", { name: /Lemon zest/ }))

    expect(screen.getByLabelText("Cost (USD)")).toBeTruthy()
    fillPurchase({ cost: "10.00", size: "1 kg" })
    fireEvent.click(screen.getByRole("button", { name: "Save price" }))

    await waitFor(() => expect(saveRecipeLineMatch).toHaveBeenCalled())
    expect(saveIngredient).toHaveBeenCalledWith({
      id: "ing-zest",
      purchaseCostCents: 1000,
      purchaseSize: 1,
      purchaseUnit: "kg",
      yieldPercent: 100,
    })
    expect(saveRecipeLineMatch).toHaveBeenCalledWith(
      "Lemon zest",
      "ing-zest",
      "ingredient"
    )
    expect(onLinked).toHaveBeenCalledWith(
      expect.objectContaining({
        line: "lemon zest",
        entry: expect.objectContaining({
          id: "ing-zest",
          purchaseCostCents: 1000,
          purchaseSize: 1,
          purchaseUnit: "kg",
        }),
      })
    )
  })

  it("leaves an already priced row on the confirm step", async () => {
    saveRecipeLineMatch.mockResolvedValue({ ok: true })
    openPicker(pricedZest)

    fireEvent.click(screen.getByRole("button", { name: /Lemon zest/ }))

    expect(screen.queryByLabelText("Cost (USD)")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Use this match" }))

    await waitFor(() =>
      expect(saveRecipeLineMatch).toHaveBeenCalledWith(
        "Lemon zest",
        "ing-zest",
        "ingredient"
      )
    )
    expect(saveIngredient).not.toHaveBeenCalled()
  })

  it("writes no price when the ingredient refuses the save", async () => {
    saveIngredient.mockResolvedValue({ error: "That input is invalid." })
    const onLinked = openPicker(unpricedZest)

    fireEvent.click(screen.getByRole("button", { name: /Lemon zest/ }))
    fillPurchase({ cost: "10.00", size: "1 kg" })
    fireEvent.click(screen.getByRole("button", { name: "Save price" }))

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "That input is invalid."
      )
    )
    expect(saveRecipeLineMatch).not.toHaveBeenCalled()
    expect(onLinked).not.toHaveBeenCalled()
  })
})

describe("new ingredient with my price", () => {
  it("creates a priced ingredient and links the line", async () => {
    saveIngredient.mockResolvedValue({ id: "ing-new", publicId: "ing_new" })
    saveRecipeLineMatch.mockResolvedValue({ ok: true })
    const onLinked = openPicker(null)

    fireEvent.click(
      screen.getByRole("button", { name: "New ingredient with my price" })
    )

    expect(
      (screen.getByLabelText("Name (required)") as HTMLInputElement).value
    ).toBe("Lemon zest")
    // The pack fields are the ones the ingredient screen asks for, so the
    // ingredient this creates is priced rather than an empty pantry row.
    fillPurchase({ cost: "12.50", size: "2 kg" })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveRecipeLineMatch).toHaveBeenCalled())
    expect(saveIngredient).toHaveBeenCalledWith({
      id: null,
      name: "Lemon zest",
      purchaseCostCents: 1250,
      purchaseSize: 2,
      purchaseUnit: "kg",
      yieldPercent: 100,
    })
    expect(linkInvoiceItem).not.toHaveBeenCalled()
    expect(saveRecipeLineMatch).toHaveBeenCalledWith(
      "Lemon zest",
      "ing-new",
      "ingredient"
    )
    expect(onLinked).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          id: "ing-new",
          purchaseCostCents: 1250,
        }),
      })
    )
  })

  it("connects the invoice item the new ingredient was priced from", async () => {
    saveIngredient.mockResolvedValue({ id: "ing-new", publicId: "ing_new" })
    linkInvoiceItem.mockResolvedValue({ ok: true })
    saveRecipeLineMatch.mockResolvedValue({ ok: true })
    searchInvoiceItems.mockResolvedValue({
      items: [
        {
          id: "line-1",
          supplier: "Acme Produce",
          description: "LEMON ZEST",
          sku: "LEM10",
          packSize: "2 kg",
          quantity: 1,
          unitPriceCents: 1250,
          lineAmountCents: 1250,
          currencyCode: "USD",
          invoiceDate: "2026-07-14",
          linkedIngredients: [],
        },
      ],
    })
    openPicker(null)

    fireEvent.click(
      screen.getByRole("button", { name: "New ingredient with my price" })
    )
    fireEvent.change(screen.getByLabelText("Invoice item"), {
      target: { value: "lemon" },
    })
    fireEvent.click(await screen.findByRole("option", { name: /LEMON ZEST/ }))
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Cost (USD)") as HTMLInputElement).value
      ).toBe("12.50")
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(linkInvoiceItem).toHaveBeenCalled())
    expect(linkInvoiceItem).toHaveBeenCalledWith("ing-new", "line-1", {
      purchaseSize: 2,
      purchaseUnit: "kg",
    })
    expect(saveRecipeLineMatch).toHaveBeenCalledWith(
      "Lemon zest",
      "ing-new",
      "ingredient"
    )
  })
})
