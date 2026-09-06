"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"
import { getPosSyncRun } from "@/lib/backend/queries"
import type { PosSyncRun } from "@/lib/backend/types"

export async function enqueuePosSync(
  provider: "square" | "shopify"
): Promise<{ syncRun: PosSyncRun } | { error: string }> {
  const parsed = z.enum(["square", "shopify"]).safeParse(provider)
  if (!parsed.success) return { error: "Unknown channel." }
  try {
    const result = await djangoAction<{ syncRun: PosSyncRun }>(
      "enqueue-pos-sync",
      { provider: parsed.data }
    )
    revalidatePath("/integrations/sales/connections")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t queue the sync.") }
  }
}

/**
 * One sync run, for the settings page to watch a queued import without
 * re-rendering the whole route every few seconds.
 */
export async function loadPosSyncRun(id: string): Promise<PosSyncRun | null> {
  await requireUser()
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return null
  return getPosSyncRun(parsed.data)
}

export async function retryPosSync(
  id: string
): Promise<{ syncRun: PosSyncRun } | { error: string }> {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return { error: "Sync run id looks malformed." }
  try {
    const result = await djangoAction<{ syncRun: PosSyncRun }>(
      "retry-pos-sync",
      { id: parsed.data }
    )
    revalidatePath("/integrations/sales/connections")
    revalidatePath("/integrations/sales/activity")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t retry the sync.") }
  }
}

export async function undoSalesImport(
  id: string
): Promise<{ ok: true; deletedLines: number } | { error: string }> {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return { error: "Sales import id looks malformed." }
  try {
    const result = await djangoAction<{ ok: true; deletedLines: number }>(
      "undo-sales-import",
      { id: parsed.data }
    )
    revalidatePath("/products")
    revalidatePath("/integrations/sales/activity")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t undo the import.") }
  }
}
