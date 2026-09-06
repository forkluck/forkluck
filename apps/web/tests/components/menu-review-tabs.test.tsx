// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
// The dialog's member picker reaches components-dialog and its menu action.
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))
vi.mock("@/app/(app)/products/actions", () => ({
  ignoreSalesCategory: vi.fn(),
  ignoreSalesSkus: vi.fn(),
  saveSalesProduct: vi.fn(),
  deleteSalesProduct: vi.fn(),
}))
const push = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/integrations/sales/mapping",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD" }),
}))

import { MenuReview, type CatalogTab } from "@/components/menu/menu-review"
import type { SalesProductRow, SalesReviewItem } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

function reviewItem(
  channel: "square" | "shopify",
  itemName: string
): SalesReviewItem {
  return {
    channel,
    providerAccountId: channel === "square" ? "M1" : "shop-1",
    matchKey: `${channel}:item:${itemName}`,
    externalObjectId: `ext-${itemName}`,
    productExternalObjectId: "",
    sku: `SKU-${itemName}`,
    itemName,
    externalVariantTitle: "",
    lineCount: 2,
    quantity: 2,
    orderSources: ["Point of Sale"],
    netSalesCents: 1000,
    hasModifiers: false,
    category: "Tea",
    lastSoldAt: null,
    suggestedProductId: null,
    suggestionReason: null,
  } as SalesReviewItem
}

const linkedProduct = {
  id: "product-1",
  name: "Linzer Cookie",
  normalizedName: "linzer cookie",
  isActive: true,
  costed: false,
  components: [],
  recipeLinks: [],
  variants: [
    {
      id: "variant-1",
      channel: "square",
      providerAccountId: "M1",
      matchKey: "square:item:LZ",
      sku: "LZ-100",
      externalName: "Cranberry Linzer",
      externalVariantTitle: "",
      identityKind: "item",
      externalObjectId: "ext-lz",
      productExternalObjectId: "",
      quantityMultiplier: 1,
      attributionPercent: null,
    },
    {
      id: "variant-2",
      channel: "square",
      providerAccountId: "M1",
      matchKey: "square:modifier:*:MOD_HONEY",
      sku: "",
      externalName: "Honey add-on",
      externalVariantTitle: "",
      identityKind: "modifier",
      externalObjectId: "MOD_HONEY",
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
  },
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as SalesProductRow

function renderTab(tab: CatalogTab) {
  return render(
    <MenuReview
      items={[reviewItem("square", "Matcha"), reviewItem("shopify", "Sencha")]}
      categories={[]}
      reviewCount={2}
      reviewMatchCount={2}
      query=""
      tab={tab}
      menuItems={[linkedProduct]}
      recipes={[]}
    />
  )
}

describe("catalog view filter", () => {
  it("offers every view and navigates to the picked one", () => {
    renderTab("review")

    // Base UI opens the menu off the pointer sequence, not the click alone.
    const trigger = screen.getByLabelText("View: Review")
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["All", "Linked", "Review", "Shopify Only", "Square Only"])

    fireEvent.click(screen.getByRole("menuitem", { name: "Linked" }))
    expect(push).toHaveBeenCalledWith(
      "/integrations/sales/mapping?tab=linked",
      {
        scroll: false,
      }
    )
  })

  it("filters review rows by channel on the provider tabs", () => {
    renderTab("shopify")

    // Groups start collapsed; the shopify row is there once opened.
    fireEvent.click(screen.getByLabelText("Expand group"))
    expect(screen.getByText("Sencha")).toBeDefined()
    expect(screen.queryByText("Matcha")).toBeNull()
  })

  it("shows linked variants on the linked tab and unions them on all", () => {
    renderTab("linked")
    expect(screen.getByText("Cranberry Linzer")).toBeDefined()
    // Modifier mappings are not provider items; they stay off this view.
    expect(screen.queryByText("Honey add-on")).toBeNull()
    expect(screen.queryByText("Matcha")).toBeNull()
    cleanup()

    renderTab("all")
    expect(screen.getByText("Cranberry Linzer")).toBeDefined()
    // Every group starts collapsed; rows appear as each one is opened.
    expect(screen.queryByText("Matcha")).toBeNull()
    for (const toggle of screen.getAllByLabelText("Expand group")) {
      fireEvent.click(toggle)
    }
    expect(screen.getByText("Matcha")).toBeDefined()
    expect(screen.getByText("Sencha")).toBeDefined()
  })

  it("remembers opened groups for the session, per tab", () => {
    renderTab("review")
    expect(screen.queryByText("Matcha")).toBeNull()
    for (const toggle of screen.getAllByLabelText("Expand group")) {
      fireEvent.click(toggle)
    }
    expect(screen.getByText("Matcha")).toBeDefined()
    expect(screen.getByText("Sencha")).toBeDefined()
    cleanup()

    // A remount of the same tab hydrates the stored open state.
    renderTab("review")
    expect(screen.getByText("Matcha")).toBeDefined()
    expect(screen.getByText("Sencha")).toBeDefined()
  })
})

describe("optimistic ignore", () => {
  function openAllGroupsAndIgnoreFirstRow() {
    renderTab("review")
    for (const toggle of screen.getAllByLabelText("Expand group")) {
      fireEvent.click(toggle)
    }
    const row = screen.getByText("Matcha").closest("div[class*='grid']")!
    fireEvent.click(
      Array.from(row.querySelectorAll("button")).find(
        (button) => button.textContent === "Ignore"
      )!
    )
    const confirm = screen
      .getAllByRole("button", { name: /Ignore/ })
      .find((button) => button.closest("[role='dialog']"))!
    fireEvent.click(confirm)
  }

  it("drops the row and closes the dialog before the server answers", async () => {
    const { ignoreSalesSkus } = await import("@/app/(app)/products/actions")
    let resolveIgnore: (value: { ignored: number }) => void = () => {}
    vi.mocked(ignoreSalesSkus).mockReturnValue(
      new Promise((resolve) => {
        resolveIgnore = resolve
      })
    )

    openAllGroupsAndIgnoreFirstRow()

    // Local-first: the row and the dialog are gone before the promise settles.
    expect(screen.queryByText("Matcha")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()

    await act(async () => {
      resolveIgnore({ ignored: 1 })
    })
    expect(screen.queryByText("Matcha")).toBeNull()
  })

  it("restores the row when the server refuses", async () => {
    const { ignoreSalesSkus } = await import("@/app/(app)/products/actions")
    let rejectIgnore: (value: { error: string }) => void = () => {}
    vi.mocked(ignoreSalesSkus).mockReturnValue(
      new Promise((resolve) => {
        rejectIgnore = resolve
      })
    )

    openAllGroupsAndIgnoreFirstRow()
    expect(screen.queryByText("Matcha")).toBeNull()

    await act(async () => {
      rejectIgnore({ error: "Backend said no" })
    })

    // The optimistic hide rolls back and the banner says why.
    expect(screen.getByText("Matcha")).toBeDefined()
    expect(screen.getByRole("alert").textContent).toContain("Backend said no")
  })
})

describe("bundles on the linked tab", () => {
  const box = {
    ...linkedProduct,
    id: "product-box",
    publicId: "prd_box",
    name: "Box of 6",
    components: [
      { productId: "product-1", productName: "Linzer Cookie", quantity: 6 },
    ],
    variants: [
      {
        ...linkedProduct.variants[0],
        id: "variant-box",
        matchKey: "square:item:BOX",
        sku: "BOX-6",
        externalName: "Box of 6",
      },
    ],
  }
  const menuItems = [linkedProduct, box] as unknown as SalesProductRow[]

  function renderLinked() {
    return render(
      <MenuReview
        items={[]}
        categories={[]}
        reviewCount={0}
        reviewMatchCount={0}
        query=""
        tab="linked"
        menuItems={menuItems}
        recipes={[]}
      />
    )
  }

  it("gives a box one product row of its own, linking to its page", () => {
    renderLinked()

    // A box is a product now: one row, its own name, its own page.
    const row = screen.getByRole("link", { name: "Box of 6" })
    expect(row.getAttribute("href")).toBe("/products/prd_box")
    expect(screen.getAllByText("Box of 6")).toHaveLength(2)
    expect(screen.getByText(/Linked · 2 variants/)).toBeDefined()
  })

  it("finds the box by its own name, not by what it contains", () => {
    renderLinked()

    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "box of 6" },
    })
    expect(screen.getByRole("link", { name: "Box of 6" })).toBeDefined()

    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "no-such-item" },
    })
    expect(screen.queryByText("Box of 6")).toBeNull()
  })
})

describe("linked search folding", () => {
  it("matches the backend's casefold for sharp s", () => {
    render(
      <MenuReview
        items={[]}
        categories={[]}
        reviewCount={0}
        reviewMatchCount={0}
        query=""
        tab="linked"
        menuItems={[
          {
            ...linkedProduct,
            name: "Straße Tee",
            variants: [linkedProduct.variants[0]],
          } as unknown as SalesProductRow,
        ]}
        recipes={[]}
      />
    )

    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "STRASSE" },
    })
    // Python casefold turns ß into ss on the Review side; the Linked filter
    // must agree or the two tabs disagree about the same name.
    expect(screen.getByText("Straße Tee")).toBeDefined()

    fireEvent.change(screen.getByLabelText("Search items"), {
      target: { value: "no-such-item" },
    })
    expect(screen.queryByText("Straße Tee")).toBeNull()
  })
})
