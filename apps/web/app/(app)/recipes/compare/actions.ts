"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionErrorMessage } from "@/lib/backend/action-error"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import type { SavedComparisonDetail } from "@/lib/backend/types"
import { COMPARE_PATH, MAX_COMPARE_RECIPES } from "@/lib/recipe/compare"

const columnSchema = z.union([
  z.object({ recipeId: z.string().min(1) }),
  z.object({
    pastedTitle: z.string().trim().max(120),
    pastedText: z.string().min(1).max(20000),
  }),
])

const saveComparisonSchema = z.object({
  id: z.string().min(1).nullable(),
  expectedEditVersion: z.number().int().min(0).optional(),
  title: z.string().trim().min(1).max(120),
  view: z.enum(["formula", "spec"]),
  baselinePosition: z.number().int().min(0).nullable(),
  columns: z.array(columnSchema).min(1).max(MAX_COMPARE_RECIPES),
})

export type SaveComparisonInput = z.input<typeof saveComparisonSchema>

export async function saveComparison(
  input: SaveComparisonInput
): Promise<
  SavedComparisonDetail | { error: string; code?: string; editVersion?: number }
> {
  const parsed = saveComparisonSchema.safeParse(input)
  if (!parsed.success) return { error: "Comparison details look malformed." }
  try {
    const result = await djangoAction<SavedComparisonDetail>(
      "save-comparison",
      parsed.data
    )
    revalidatePath(COMPARE_PATH)
    return result
  } catch (cause) {
    if (cause instanceof BackendRequestError && cause.code === "stale_write") {
      return {
        error: cause.message,
        code: cause.code,
        editVersion: cause.editVersion,
      }
    }
    return {
      error: actionErrorMessage(cause, "Couldn’t save the comparison."),
    }
  }
}

export async function deleteComparison(
  id: string
): Promise<{ ok: true } | { error: string }> {
  const parsed = z.string().min(1).safeParse(id)
  if (!parsed.success) return { error: "Comparison id is required." }
  try {
    const result = await djangoAction<{ ok: true }>("delete-comparison", {
      id: parsed.data,
    })
    revalidatePath(COMPARE_PATH)
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t delete the comparison."),
    }
  }
}
