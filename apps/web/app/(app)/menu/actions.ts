"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionErrorMessage } from "@/lib/backend/action-error"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import { getMenuProductRows } from "@/lib/backend/queries"
import type { MenuDetail, SalesProductRow } from "@/lib/backend/types"

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.")
  .nullable()

const menuItemSchema = z
  .object({
    id: z.string().min(1).nullable(),
    name: z.string().trim().max(200),
    recipeId: z.string().min(1).nullable(),
    productId: z.string().min(1).nullable(),
    sellPriceCents: z.number().int().min(0).max(100000000),
    qtySold: z.number().min(0).max(1000000),
    position: z.number().int().min(0),
  })
  .refine((item) => item.recipeId === null || item.productId === null, {
    message: "A menu item is a recipe or a product, not both",
  })
  // An unlinked row is a plain named line; a nameless one is nothing at all.
  .refine(
    (item) =>
      item.recipeId !== null || item.productId !== null || item.name !== "",
    { message: "Name every item" }
  )

const saveMenuSchema = z.object({
  id: z.string().min(1).nullable(),
  name: z.string().min(1).max(120),
  periodStart: isoDate,
  periodEnd: isoDate,
  rebaseline: z.boolean().optional(),
  expectedEditVersion: z.number().int().min(0).optional(),
  items: z.array(menuItemSchema).max(500),
})

export async function saveMenu(
  input: z.input<typeof saveMenuSchema>
): Promise<
  MenuDetail | { error: string; code?: string; editVersion?: number }
> {
  const parsed = saveMenuSchema.safeParse(input)
  if (!parsed.success) return { error: "Menu details look malformed." }
  try {
    const result = await djangoAction<MenuDetail>("save-menu", parsed.data)
    revalidatePath("/menu")
    revalidatePath(`/menu/${result.menu.publicId}`)
    return result
  } catch (cause) {
    // The editor tells a refused stale write apart from every other failure.
    if (cause instanceof BackendRequestError && cause.code === "stale_write") {
      return {
        error: cause.message,
        code: cause.code,
        editVersion: cause.editVersion,
      }
    }
    return { error: actionErrorMessage(cause, "Couldn’t save the menu.") }
  }
}

export async function deleteMenu(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Menu id is required." }
  try {
    const result = await djangoAction<{ ok: true }>("delete-menu", {
      id: parsed.data,
    })
    revalidatePath("/menu")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete the menu.") }
  }
}

const loadMenuProductsSchema = z.object({
  q: z.string().max(120).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
})

/** The picker behind the import dialog and the worksheet's product links,
 * priced over the menu's period. */
export async function loadMenuProducts(
  input: z.input<typeof loadMenuProductsSchema>
): Promise<{ items: SalesProductRow[] } | { error: string }> {
  const parsed = loadMenuProductsSchema.safeParse(input)
  if (!parsed.success) return { error: "That search looks malformed." }
  try {
    const result = await getMenuProductRows({
      q: parsed.data.q,
      start: parsed.data.start,
      end: parsed.data.end,
    })
    return { items: result.items }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t load products.") }
  }
}
