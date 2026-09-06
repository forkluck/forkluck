import "server-only"

import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import { updateInvoiceAiUsageForWorkspace } from "@/lib/backend/queries"

export class InvoiceAiBudgetError extends Error {
  constructor(
    message: string,
    readonly limitReached: boolean
  ) {
    super(message)
  }
}

export type InvoiceAiBudget = {
  beforeCall: (attempts: number) => Promise<void>
  record: (usage: {
    inputTokens?: number
    outputTokens?: number
  }) => Promise<void>
}

/** One controller per file, shared by detection, crops, and escalation. The
 * first actual model call reserves the pages; subsequent calls reserve only
 * attempts. A timeout keeps its reservation because it may have been billed. */
export function invoiceAiBudget(
  pages: number,
  userId?: string
): InvoiceAiBudget {
  let readId: string | null = null
  let exempt = false
  let inputTokens = 0
  let outputTokens = 0
  const send = <T>(body: Record<string, unknown>) =>
    userId
      ? updateInvoiceAiUsageForWorkspace<T>(userId, body)
      : djangoAction<T>("invoice-ai-usage", body)

  return {
    async beforeCall(attempts) {
      if (exempt) return
      try {
        const result = await send<{ readId: string | null }>({
          operation: "reserve",
          readId,
          pages: readId ? 0 : pages,
          attempts,
        })
        readId = result.readId
        exempt = readId === null
      } catch (cause) {
        const limited =
          cause instanceof BackendRequestError &&
          cause.code === "invoice_ai_limit_reached"
        throw new InvoiceAiBudgetError(
          limited
            ? cause.message
            : "Couldn't check your AI allowance. Please try again.",
          limited
        )
      }
    },
    async record(usage) {
      if (!readId) return
      inputTokens += usage.inputTokens ?? 0
      outputTokens += usage.outputTokens ?? 0
      try {
        await send({ operation: "record", readId, inputTokens, outputTokens })
      } catch {
        // The reservation remains charged. A telemetry outage must not turn
        // a completed scan into a failed scan that the customer retries.
        console.warn("Invoice AI token usage could not be recorded")
      }
    },
  }
}
