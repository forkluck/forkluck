"use server"

import { z } from "zod"

import { toSearchItems } from "@/components/search/search-items"
import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"
import { getIngredientOptions, getSearchIndex } from "@/lib/backend/queries"
import type { PrimoConversationSummary } from "@/lib/backend/types"
import {
  KITCHEN_TOOL_NAMES,
  type KitchenToolName,
} from "@/lib/primo/kitchen-tools"
import type { KitchenToolResult } from "@/lib/primo/kitchen-tool-results"
import { runKitchenTool } from "@/lib/primo/tools"

export async function loadIngredientOptions() {
  await requireUser()
  return getIngredientOptions()
}

export async function searchApp(query: string) {
  await requireUser()
  return toSearchItems(await getSearchIndex(query))
}

export async function runKitchenToolAction(
  name: KitchenToolName,
  input: unknown
): Promise<KitchenToolResult> {
  await requireUser()
  if (!KITCHEN_TOOL_NAMES.includes(name)) throw new Error("Unknown tool.")
  return runKitchenTool(name, input)
}

const conversationIdSchema = z.uuid()

export async function renamePrimoConversation(
  conversationId: string,
  title: string
) {
  await requireUser()
  const parsed = z
    .strictObject({
      conversationId: conversationIdSchema,
      title: z.string().trim().min(1).max(200),
    })
    .safeParse({ conversationId, title })
  if (!parsed.success) return { error: "Give this conversation a title." }
  try {
    return await djangoAction<{ item: PrimoConversationSummary }>(
      "primo-rename-conversation",
      parsed.data
    )
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t rename that chat.") }
  }
}

export async function archivePrimoConversation(
  conversationId: string,
  archived: boolean
) {
  await requireUser()
  const parsed = z
    .strictObject({
      conversationId: conversationIdSchema,
      archived: z.boolean(),
    })
    .safeParse({ conversationId, archived })
  if (!parsed.success) return { error: "Conversation not found" }
  try {
    return await djangoAction<{ item: PrimoConversationSummary }>(
      "primo-archive-conversation",
      parsed.data
    )
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t archive that chat.") }
  }
}

export async function deletePrimoConversation(conversationId: string) {
  await requireUser()
  const parsed = conversationIdSchema.safeParse(conversationId)
  if (!parsed.success) return { error: "Conversation not found" }
  try {
    const result = await djangoAction<{ ok: true }>(
      "primo-delete-conversation",
      {
        conversationId: parsed.data,
      }
    )
    const { cleanupPrimoAttachments } =
      await import("@/lib/primo/attachment-server")
    await cleanupPrimoAttachments().catch(() => {})
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t delete that chat.") }
  }
}

export async function savePrimoFeedback(
  conversationId: string,
  messageId: string,
  rating: "" | "up" | "down",
  comment = ""
) {
  await requireUser()
  const parsed = z
    .strictObject({
      conversationId: z.uuid(),
      messageId: z.string().min(1).max(64),
      rating: z.enum(["", "up", "down"]),
      comment: z.string().max(2000),
    })
    .safeParse({ conversationId, messageId, rating, comment })
  if (!parsed.success) return { error: "Invalid feedback." }
  try {
    return await djangoAction<{ ok: true }>("primo-feedback", parsed.data)
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save feedback.") }
  }
}
