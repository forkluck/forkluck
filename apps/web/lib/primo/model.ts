import "server-only"

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { PrimoMention } from "@/lib/primo/messages"
import type { PrimoAttachment } from "@/lib/primo/attachments"

type GatewayIdentity = {
  version: 1
  userId: string
  conversationId: string
  turnId: string
  deadlineAt: number
}
export type PrimoGatewayContext = GatewayIdentity &
  (
    | {
        task: "chat"
        today: string
        recipeRef: string | null
        productRef: string | null
        mentions: PrimoMention[]
        attachments: Pick<
          PrimoAttachment,
          "id" | "name" | "mediaType" | "coverage"
        >[]
      }
    | { task: "title" }
    | { task: "vision"; attachmentId: string; page?: number }
  )

// The public application owns turn budgets and the tool loop. Provider/model
// choices and instructions belong to the private service.
export function primoGenerationLimits(hasAttachments: boolean) {
  return hasAttachments
    ? { maxOutputTokens: 6_000, timeoutMs: 90_000, maxSteps: 6 }
    : { maxOutputTokens: 1_800, timeoutMs: 45_000, maxSteps: 4 }
}

function gatewayUrl() {
  return process.env.PRIMO_BASE_URL?.trim() || "https://primo.forkluck.com/v1"
}
export function primoConfigured(): boolean {
  if (!process.env.PRIMO_API_KEY?.trim()) return false
  try {
    const url = new URL(gatewayUrl())
    const secure =
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return (
      secure &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/\/$/, "") === "/v1"
    )
  } catch {
    return false
  }
}

export function primoModel(
  context: PrimoGatewayContext,
  fetch?: typeof globalThis.fetch
) {
  if (!primoConfigured()) throw new Error("Primo is not configured")
  return createOpenAICompatible({
    name: "primo",
    apiKey: process.env.PRIMO_API_KEY!.trim(),
    baseURL: gatewayUrl(),
    includeUsage: true,
    fetch,
    // Called for every model step, including calls after a kitchen tool. The
    // context is server-built and never taken from a browser-provided envelope.
    transformRequestBody: (body) => ({ ...body, primo_context: context }),
  })("primo")
}
