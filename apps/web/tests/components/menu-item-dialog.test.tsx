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

const saveMenuItem = vi.fn()

vi.mock("@/app/(app)/products/actions", () => ({
  saveMenuItem: (input: unknown) => saveMenuItem(input),
}))
// The member picker reaches components-dialog, which imports a menu action.
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))

import { MenuItemDialog } from "@/components/menu/menu-item-dialog"
import { ToastProvider } from "@/components/ui/toast"
import type { SalesProductRow } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function product(overrides: Partial<SalesProductRow> = {}): SalesProductRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    publicId: "prd_000000000001",
    editVersion: 0,
    name: "Linzer Cookie",
    normalizedName: "linzer cookie",
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
    variants: [],
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

describe("the name field stays put", () => {
  const linzer = product({ id: "product-a", name: "Linzer" })

  function renderTrack() {
    return render(
      <ToastProvider>
        <MenuItemDialog
          open
          onOpenChange={vi.fn()}
          products={[linzer]}
          recipes={[]}
          initialName="Tea and biscuits"
          onProductChoice={vi.fn()}
          initialVariant={{
            channel: "square",
            providerAccountId: "M1",
            matchKey: "square:item:VAR9",
            sku: "SKU9",
            externalName: "Sampler",
            externalVariantTitle: "",
          }}
        />
      </ToastProvider>
    )
  }

  it("lets a box keep typing the name the channel gave it", () => {
    renderTrack()

    const field = () => screen.getByLabelText("Name") as HTMLInputElement
    expect(field().hasAttribute("disabled")).toBe(false)
    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    // The box is a new product, so it names itself.
    expect(field().hasAttribute("disabled")).toBe(false)
    expect(field().value).toBe("Tea and biscuits")
  })

  it("keeps the field and shows the product's own name once one is linked", () => {
    render(
      <ToastProvider>
        <MenuItemDialog
          open
          onOpenChange={vi.fn()}
          product={linzer}
          products={[linzer]}
          recipes={[]}
          onProductChoice={vi.fn()}
          initialVariant={{
            channel: "square",
            providerAccountId: "M1",
            matchKey: "square:item:VAR9",
            sku: "SKU9",
            externalName: "Sampler",
            externalVariantTitle: "",
          }}
        />
      </ToastProvider>
    )

    const field = screen.getByLabelText("Name") as HTMLInputElement
    expect(field.hasAttribute("disabled")).toBe(true)
    expect(field.value).toBe("Linzer")
  })
})

describe("track dialog bundle kind", () => {
  const linzer = product({ id: "product-a", name: "Linzer" })
  const kipferl = product({
    id: "product-b",
    publicId: "prd_000000000002",
    name: "Kipferl",
  })

  function renderTrack(items: ReturnType<typeof product>[] = []) {
    return render(
      <ToastProvider>
        <MenuItemDialog
          open
          onOpenChange={vi.fn()}
          products={items}
          recipes={[]}
          initialName="Tea and biscuits"
          onProductChoice={vi.fn()}
          initialVariant={{
            channel: "square",
            providerAccountId: "M1",
            matchKey: "square:item:BOX",
            sku: "BOX",
            externalName: "Tea and biscuits",
            externalVariantTitle: "",
          }}
        />
      </ToastProvider>
    )
  }

  function pickMember(name: string) {
    const field = screen.getByLabelText("Add product component")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: name } })
    fireEvent.click(screen.getByRole("option", { name: `${name}Product` }))
  }

  it("disables the product picker for a box", () => {
    renderTrack()

    expect(
      screen.getByLabelText("Product to link").hasAttribute("disabled")
    ).toBe(false)

    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    expect(
      screen.getByLabelText("Product to link").hasAttribute("disabled")
    ).toBe(true)
  })

  it("saves the box as a product whose components are its members", async () => {
    saveMenuItem.mockResolvedValue({
      id: "product-box",
      publicId: "prd_000000000003",
      claimedLines: 0,
    })
    renderTrack([linzer, kipferl])

    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    pickMember("Linzer")
    pickMember("Kipferl")
    fireEvent.change(screen.getByLabelText("Units of Linzer per box"), {
      target: { value: "4" },
    })
    fireEvent.change(screen.getByLabelText("Units of Kipferl per box"), {
      target: { value: "6" },
    })
    fireEvent.change(screen.getByLabelText("Price"), {
      target: { value: "24.00" },
    })
    fireEvent.change(screen.getByLabelText("Counts as % of the sale"), {
      target: { value: "80" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveMenuItem).toHaveBeenCalled())
    const payload = saveMenuItem.mock.calls[0][0]
    expect(payload).toMatchObject({
      id: null,
      name: "Tea and biscuits",
      isActive: true,
      recipeLinks: [],
      sellPriceCents: 2400,
      components: [
        {
          recipeId: null,
          ingredientId: null,
          productId: "product-a",
          quantity: 4,
          unit: "",
          position: 0,
        },
        {
          recipeId: null,
          ingredientId: null,
          productId: "product-b",
          quantity: 6,
          unit: "",
          position: 1,
        },
      ],
    })
    // The box is one product; the counts live in its components.
    expect(payload.variants).toHaveLength(1)
    expect(payload.variants[0].quantityMultiplier).toBe(1)
    expect(payload.variants[0].attributionPercent).toBe(80)
    expect(payload.variants[0]).not.toHaveProperty("kind")
    expect(payload.variants[0]).not.toHaveProperty("members")
  })

  it("omits the price when the merchant leaves it blank", async () => {
    saveMenuItem.mockResolvedValue({ id: "product-box", claimedLines: 0 })
    renderTrack([linzer, kipferl])

    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    pickMember("Linzer")
    pickMember("Kipferl")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveMenuItem).toHaveBeenCalled())
    const payload = saveMenuItem.mock.calls[0][0]
    expect(payload.sellPriceCents).toBeUndefined()
    expect(payload.variants[0].attributionPercent).toBeNull()
  })

  it("offers each product once and refuses a fractional unit", async () => {
    renderTrack([linzer, kipferl])

    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    pickMember("Linzer")
    const field = screen.getByLabelText("Add product component")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Linzer" } })
    expect(screen.queryByRole("option")).toBeNull()

    pickMember("Kipferl")
    fireEvent.change(screen.getByLabelText("Units of Linzer per box"), {
      target: { value: "1.5" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("whole number")
    )
    expect(saveMenuItem).not.toHaveBeenCalled()
  })

  it("refuses a box of fewer than two products", async () => {
    renderTrack([linzer, kipferl])

    fireEvent.click(screen.getByRole("radio", { name: /box of several/ }))
    pickMember("Linzer")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("2 and 50")
    )
    expect(saveMenuItem).not.toHaveBeenCalled()
  })

  it("says how much of the sale stays unattributed", () => {
    renderTrack([linzer, kipferl])

    // Blank says nothing: it is the default and counts for everything.
    expect(screen.queryByText(/whole sale/)).toBeNull()
    fireEvent.change(screen.getByLabelText("Counts as % of the sale"), {
      target: { value: "80" },
    })
    expect(
      screen.getByText("20% of the sale stays unattributed.")
    ).toBeDefined()
  })
})

describe("dismissing the track dialog", () => {
  function renderTrack(onOpenChange = vi.fn()) {
    render(
      <ToastProvider>
        <MenuItemDialog
          open
          onOpenChange={onOpenChange}
          initialName="Tea and biscuits"
          initialVariant={{
            channel: "square",
            providerAccountId: "M1",
            matchKey: "square:item:VAR9",
            sku: "SKU9",
            externalName: "Sampler",
            externalVariantTitle: "",
          }}
        />
      </ToastProvider>
    )
    return onOpenChange
  }

  it("asks before dropping a typed name", () => {
    renderTrack()

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Linzer" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.getByText("Discard changes?")).toBeDefined()
  })

  it("closes straight away when nothing was touched", () => {
    const onOpenChange = renderTrack()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("dismissing the track dialog after a product is chosen", () => {
  const linzer = product({ id: "product-a", name: "Linzer" })

  // The parent feeds the chosen product straight back in, the way
  // menu-review does.
  function TrackHarness() {
    const [chosen, setChosen] = React.useState<SalesProductRow | null>(null)
    return (
      <MenuItemDialog
        open
        onOpenChange={vi.fn()}
        product={chosen ?? undefined}
        products={[linzer]}
        recipes={[]}
        onProductChoice={(id) => setChosen(id === linzer.id ? linzer : null)}
        initialVariant={{
          channel: "square",
          providerAccountId: "M1",
          matchKey: "square:item:VAR9",
          sku: "SKU9",
          externalName: "Sampler",
          externalVariantTitle: "",
        }}
      />
    )
  }

  it("asks before dropping the chosen link", async () => {
    render(
      <ToastProvider>
        <TrackHarness />
      </ToastProvider>
    )

    fireEvent.click(screen.getByLabelText("Product to link"))
    fireEvent.click(await screen.findByRole("button", { name: /Linzer/ }))
    await waitFor(() =>
      expect(screen.getByLabelText("Product to link").textContent).toContain(
        "Linzer"
      )
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.getByText("Discard changes?")).toBeDefined()
  })
})
