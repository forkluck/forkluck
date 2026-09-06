// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ProductAssociationPicker } from "@/components/menu/product-association-picker"
import type { SalesProductRow } from "@/lib/backend/types"

afterEach(cleanup)

function product(overrides: Partial<SalesProductRow> = {}): SalesProductRow {
  return {
    id: "product-1",
    publicId: "prd_000000000001",
    editVersion: 0,
    name: "Pineapple Linzer",
    normalizedName: "pineapple linzer",
    sku: "",
    skus: [],
    description: "",
    sellPriceCents: 0,
    baseUnit: "",
    category: "",
    isActive: true,
    costed: false,
    components: [],
    recipeLinks: [],
    variants: [
      {
        id: "variant-1",
        channel: "square",
        providerAccountId: "merchant-1",
        matchKey: "square:item:one",
        sku: "200120",
        externalName: "Pineapple Linzer",
        externalVariantTitle: "",
        identityKind: "item",
        externalObjectId: "one",
        productExternalObjectId: "",
        quantityMultiplier: 1,
        attributionPercent: null,
      },
    ],
    sales: {
      lineCount: 0,
      quantity: 0,
      totalQuantity: 0,
      grossCents: 0,
      discountCents: 0,
      netSalesCents: 0,
      attributedNetSalesCents: 0,
      taxCents: 0,
      refundCents: 0,
      sharedToMembers: false,
      asSoldNetSalesCents: 0,
      splitBasis: null,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const ARIA_LABEL = "Menu product for Milk choice"

describe("product association picker", () => {
  it("names the mapped product that is no longer an eligible choice", () => {
    // Archiving the product removes it from the selectable list, but sales
    // are still attributed to it, so the picker must not read "Not associated".
    const archived = product({
      id: "product-archived",
      name: "Oat Milk",
      isActive: false,
    })

    render(
      <ProductAssociationPicker
        products={[product()]}
        value={archived.id}
        currentProduct={archived}
        allowIgnore
        ariaLabel={ARIA_LABEL}
        onValueChange={vi.fn()}
      />
    )

    expect(screen.getByLabelText(ARIA_LABEL).textContent).toContain("Oat Milk")
    expect(screen.getByLabelText(ARIA_LABEL).textContent).not.toContain(
      "Not associated"
    )
  })

  it("keeps the association when the retained product is chosen again", () => {
    const archived = product({
      id: "product-archived",
      name: "Oat Milk",
      isActive: false,
    })
    const onValueChange = vi.fn()

    render(
      <ProductAssociationPicker
        products={[product()]}
        value={archived.id}
        currentProduct={archived}
        allowIgnore
        ariaLabel={ARIA_LABEL}
        onValueChange={onValueChange}
      />
    )

    fireEvent.click(screen.getByLabelText(ARIA_LABEL))
    // The retained row carries the hint, which separates it from the trigger.
    const option = screen
      .getAllByRole("button")
      .find((element) => element.textContent?.includes("Still counted here"))
    expect(option?.textContent).toContain("Oat Milk")

    fireEvent.click(option!)
    // The old failure mode reported the current row as "Not associated" and
    // cleared the mapping on the next save.
    expect(onValueChange).toHaveBeenCalledWith("product-archived")
    expect(onValueChange).not.toHaveBeenCalledWith("")
  })

  it("still reports an unmapped modifier as not associated", () => {
    render(
      <ProductAssociationPicker
        products={[product()]}
        value=""
        allowIgnore
        ariaLabel={ARIA_LABEL}
        onValueChange={vi.fn()}
      />
    )

    expect(screen.getByLabelText(ARIA_LABEL).textContent).toContain(
      "Not associated"
    )
  })

  it("ignores a bare Enter instead of clearing the mapping", () => {
    const onValueChange = vi.fn()
    render(
      <ProductAssociationPicker
        products={[product()]}
        value="product-1"
        allowIgnore
        ariaLabel={ARIA_LABEL}
        onValueChange={onValueChange}
      />
    )

    fireEvent.click(screen.getByLabelText(ARIA_LABEL))
    fireEvent.keyDown(screen.getByLabelText("Search product title or SKU"), {
      key: "Enter",
    })

    // The empty box's first row is "Not associated".
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("picks the top result once a search has been typed", () => {
    const onValueChange = vi.fn()
    render(
      <ProductAssociationPicker
        products={[product()]}
        value=""
        allowIgnore
        ariaLabel={ARIA_LABEL}
        onValueChange={onValueChange}
      />
    )

    fireEvent.click(screen.getByLabelText(ARIA_LABEL))
    const search = screen.getByLabelText("Search product title or SKU")
    fireEvent.change(search, { target: { value: "Pineapple" } })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onValueChange).toHaveBeenCalledWith("product-1")
  })
})
