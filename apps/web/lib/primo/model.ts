import "server-only"

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

import { QWEN_BASE_URL } from "@/lib/ai/providers"

export const QWEN_MODEL = process.env.QWEN_MODEL?.trim() || "qwen3.7-plus"

// Document drafts can contain several complete recipes in tool arguments.
export function primoGenerationLimits(hasAttachments: boolean) {
  return hasAttachments
    ? { maxOutputTokens: 6_000, timeoutMs: 90_000, maxSteps: 6 }
    : { maxOutputTokens: 1_800, timeoutMs: 45_000, maxSteps: 4 }
}

export function primoConfigured(): boolean {
  const apiKey = process.env.QWEN_API_KEY?.trim()
  if (!apiKey || !QWEN_MODEL) return false
  try {
    return new URL(QWEN_BASE_URL).protocol === "https:"
  } catch {
    return false
  }
}

export function primoModel(fetch?: typeof globalThis.fetch) {
  if (!primoConfigured()) throw new Error("Primo is not configured")
  const qwen = createOpenAICompatible({
    name: "qwen",
    apiKey: process.env.QWEN_API_KEY!.trim(),
    baseURL: QWEN_BASE_URL,
    fetch,
  })
  return qwen(QWEN_MODEL)
}
