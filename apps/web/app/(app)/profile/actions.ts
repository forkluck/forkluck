"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"

/** Sign one phone out. The backend deletes the token; the row is gone on re-render. */
export async function revokeDevice(
  id: string
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return { error: "Unknown device." }
  try {
    await djangoAction("revoke-device", { id: parsed.data })
    revalidatePath("/profile")
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t sign that phone out.") }
  }
}

/**
 * Delete the signed-in account. Django runs the same command the admin's
 * delete does; the caller then leaves through /logout, so nothing here is
 * revalidated — every page of this workspace is about to be gone.
 */
export async function deleteAccount(): Promise<
  { ok: true } | { error: string }
> {
  await requireUser()
  try {
    await djangoAction("delete-account", {})
    return { ok: true }
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete your account.") }
  }
}
