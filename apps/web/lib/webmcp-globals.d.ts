import type { KitchenToolDescriptor } from "@/lib/primo/kitchen-tools"

type ModelContextTool = KitchenToolDescriptor & {
  execute: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => unknown | Promise<unknown>
}

interface ModelContext {
  registerTool(
    tool: ModelContextTool,
    options?: { signal?: AbortSignal }
  ): Promise<void>
}

declare global {
  interface Document {
    modelContext?: ModelContext
  }
}

export {}
