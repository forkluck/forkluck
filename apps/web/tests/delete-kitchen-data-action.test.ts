import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * What `deleteKitchenData` puts on the wire and what it invalidates after.
 *
 * The reset empties recipes, ingredients, menus, invoices, labor and products
 * at once, so every list that reads them has to be revalidated; a path dropped
 * from that set leaves a page serving rows Django no longer has. The backend
 * tests post to Django directly and never exercise this seam.
 */

const sent: { slug: string; body: Record<string, unknown> }[] = []
const revalidated: string[] = []
let rejection: unknown = null
let response: unknown = {
  ok: true,
  deleted: { recipes: 2, ingredients: 3, menus: 1, invoices: 0, employees: 0 },
}

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path)
  },
}))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({}),
}))
vi.mock("@/lib/backend/queries", () => ({
  getInvoiceSuppliers: () => Promise.resolve([]),
}))
// The real error classes come through: actionErrorMessage narrows on them.
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction: (slug: string, body: Record<string, unknown>) => {
    sent.push({ slug, body })
    return rejection ? Promise.reject(rejection) : Promise.resolve(response)
  },
}))

const { deleteKitchenData } = await import("@/app/(app)/settings/actions")

describe("deleteKitchenData", () => {
  beforeEach(() => {
    sent.length = 0
    revalidated.length = 0
    rejection = null
    response = {
      ok: true,
      deleted: {
        recipes: 2,
        ingredients: 3,
        menus: 1,
        invoices: 0,
        employees: 0,
      },
    }
  })

  it("posts an empty body and returns the counts Django reported", async () => {
    const result = await deleteKitchenData()

    expect(sent).toEqual([{ slug: "delete-kitchen-data", body: {} }])
    expect(result).toEqual({
      ok: true,
      deleted: {
        recipes: 2,
        ingredients: 3,
        menus: 1,
        invoices: 0,
        employees: 0,
      },
    })
  })

  it("revalidates every surface the reset empties", async () => {
    await deleteKitchenData()

    expect(revalidated.sort()).toEqual(
      [
        "/",
        "/ingredients",
        "/invoices",
        "/labor",
        "/menus",
        "/products",
        "/recipes",
      ].sort()
    )
  })

  it("reports a failure instead of throwing, and revalidates nothing", async () => {
    // Django's message when there is one; the fallback when the throw carries none.
    rejection = { status: 500 }

    expect(await deleteKitchenData()).toEqual({
      error: "Couldn’t delete your kitchen data.",
    })
    expect(revalidated).toEqual([])
  })
})
