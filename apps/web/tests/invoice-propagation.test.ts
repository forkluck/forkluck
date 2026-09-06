import { describe, expect, it } from "vitest"

import {
  applyLineChange,
  propagateResolution,
  type PropagationInvoice,
  type PropagationLine,
} from "../lib/invoice-propagation"

function line(
  key: string,
  itemKey: string,
  overrides: Partial<PropagationLine> = {}
): PropagationLine {
  return {
    key,
    mode: "review",
    propagated: false,
    categoryId: null,
    ingredientId: "",
    name: "",
    amount: "",
    unit: "lb",
    price: "",
    remember: true,
    entry: { itemKey, match: { kind: "review" } },
    ...overrides,
  }
}

function invoice(
  key: string,
  supplierName: string,
  lines: PropagationLine[]
): PropagationInvoice {
  return {
    key,
    supplierName,
    result: { supplier: "baldor", supplierName },
    lines,
  }
}

/** A line the merchant just filled in and marked resolved. */
const resolvedSource = line("a-1", "dabut11", {
  mode: "resolved",
  categoryId: "cat-ingredients",
  ingredientId: "ing-butter",
  name: "Butter",
  amount: "36",
  unit: "lb",
  price: "142.50",
})

describe("propagateResolution", () => {
  it("answers the same item in the same invoice and in the others", () => {
    const invoices = [
      invoice("a", "Baldor", [resolvedSource, line("a-2", "dabut11")]),
      invoice("b", "Baldor", [line("b-1", "dabut11"), line("b-2", "flour8c")]),
    ]
    expect(
      propagateResolution(invoices, { invoiceKey: "a", lineKey: "a-1" })
    ).toEqual([
      {
        invoiceKey: "a",
        lineKey: "a-2",
        patch: {
          mode: "resolved",
          propagated: true,
          ingredientId: "ing-butter",
          name: "Butter",
          amount: "36",
          unit: "lb",
          price: "142.50",
          categoryId: "cat-ingredients",
          remember: true,
        },
      },
      {
        invoiceKey: "b",
        lineKey: "b-1",
        patch: {
          mode: "resolved",
          propagated: true,
          ingredientId: "ing-butter",
          name: "Butter",
          amount: "36",
          unit: "lb",
          price: "142.50",
          categoryId: "cat-ingredients",
          remember: true,
        },
      },
    ])
  })

  it("leaves confirmed memory and hand-answered lines alone", () => {
    const invoices = [
      invoice("a", "Baldor", [
        resolvedSource,
        line("a-2", "dabut11", {
          mode: "auto",
          entry: { itemKey: "dabut11", match: { kind: "update" } },
        }),
        line("a-3", "dabut11", { mode: "resolved" }),
        line("a-4", "dabut11", { mode: "ignored" }),
        line("a-5", "dabut11", {
          mode: "auto",
          entry: { itemKey: "dabut11", match: { kind: "new" } },
        }),
        line("a-6", "dabut11", { mode: "resolving" }),
        line("a-7", ""),
      ]),
    ]
    expect(
      propagateResolution(invoices, { invoiceKey: "a", lineKey: "a-1" }).map(
        (target) => target.lineKey
      )
    ).toEqual(["a-5", "a-6"])
  })

  it("keeps a target's own price and borrows only its missing fields", () => {
    const invoices = [
      invoice("a", "Baldor", [
        resolvedSource,
        line("a-2", "dabut11", { price: "139.00", categoryId: "cat-other" }),
      ]),
    ]
    const [target] = propagateResolution(invoices, {
      invoiceKey: "a",
      lineKey: "a-1",
    })
    expect(target.patch.price).toBeUndefined()
    expect(target.patch.categoryId).toBeUndefined()
    expect(target.patch.amount).toBe("36")
  })

  it("lets a proposed new product keep its own pack and price", () => {
    const invoices = [
      invoice("a", "Baldor", [
        resolvedSource,
        line("a-2", "dabut11", {
          mode: "auto",
          entry: {
            itemKey: "dabut11",
            match: {
              kind: "new",
              cost: { packAmount: 36, packUnit: "lb", packPriceCents: 13900 },
            },
          },
        }),
      ]),
    ]
    const [target] = propagateResolution(invoices, {
      invoiceKey: "a",
      lineKey: "a-1",
    })
    expect(target.patch).toEqual({
      mode: "resolved",
      propagated: true,
      ingredientId: "ing-butter",
      name: "Butter",
      amount: "36",
      unit: "lb",
      price: "139.00",
      categoryId: "cat-ingredients",
      remember: true,
    })
  })

  it("carries a declined memory to the same item's other lines", () => {
    const invoices = [
      invoice("a", "Baldor", [
        { ...resolvedSource, remember: false },
        line("a-2", "dabut11", { remember: true }),
      ]),
    ]
    const [target] = propagateResolution(invoices, {
      invoiceKey: "a",
      lineKey: "a-1",
    })
    expect(target.patch.remember).toBe(false)
  })

  it("propagates an ignore as identity-free", () => {
    const invoices = [
      invoice("a", "Baldor", [
        line("a-1", "desc:linen", { mode: "ignored" }),
        line("a-2", "desc:linen"),
      ]),
    ]
    expect(
      propagateResolution(invoices, { invoiceKey: "a", lineKey: "a-1" })
    ).toEqual([
      {
        invoiceKey: "a",
        lineKey: "a-2",
        patch: { mode: "ignored", propagated: true },
      },
    ])
  })

  it("does not cross suppliers", () => {
    const invoices = [
      invoice("a", "Baldor", [resolvedSource]),
      invoice("b", "Wegmans", [line("b-1", "dabut11")]),
    ]
    expect(
      propagateResolution(invoices, { invoiceKey: "a", lineKey: "a-1" })
    ).toEqual([])
  })
})

describe("applyLineChange", () => {
  it("resolves the clicked line and its twins in one update", () => {
    const invoices = [
      invoice("a", "Baldor", [
        line("a-1", "dabut11", {
          mode: "resolving",
          ingredientId: "ing-butter",
          name: "Butter",
          amount: "36",
          price: "142.50",
        }),
      ]),
      invoice("b", "Baldor", [line("b-1", "dabut11")]),
    ]
    const next = applyLineChange(invoices, "a", "a-1", { mode: "resolved" })
    expect(next[0].lines[0]).toMatchObject({
      mode: "resolved",
      propagated: false,
    })
    expect(next[1].lines[0]).toMatchObject({
      mode: "resolved",
      propagated: true,
      ingredientId: "ing-butter",
      price: "142.50",
    })
  })

  it("propagates only when the click settles a line", () => {
    const invoices = [
      invoice("a", "Baldor", [
        line("a-1", "dabut11", { mode: "resolved", propagated: true }),
        line("a-2", "dabut11"),
      ]),
    ]
    const next = applyLineChange(invoices, "a", "a-2", {
      categoryId: "cat-ingredients",
    })
    expect(next[0].lines[1]).toMatchObject({
      mode: "review",
      propagated: false,
    })
  })

  it("undo returns the line to review and clears the flag", () => {
    const invoices = [
      invoice("a", "Baldor", [
        line("a-1", "dabut11", { mode: "resolved", propagated: true }),
        line("a-2", "dabut11"),
      ]),
    ]
    const next = applyLineChange(invoices, "a", "a-1", {
      mode: "review",
      propagated: false,
    })
    expect(next[0].lines[0]).toMatchObject({
      mode: "review",
      propagated: false,
    })
    expect(next[0].lines[1].mode).toBe("review")
  })
})
