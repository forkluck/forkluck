"use server"

import { z } from "zod"

import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"

const checkoutSessionIdSchema = z.string().trim().min(1).max(255).optional()

export async function createStripeCheckout(): Promise<
  { url: string } | { error: string }
> {
  try {
    return await djangoAction<{ url: string }>("create-stripe-checkout", {})
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t start checkout. Try again."),
    }
  }
}

export async function syncStripeSubscription(
  checkoutSessionId?: string
): Promise<
  | {
      status: string
      plan: string
      trialDaysLeft: number | null
      locked: boolean
    }
  | { error: string }
> {
  // A mangled session id (the URL is user-visible) falls back to the
  // customer-level sync instead of surfacing a validation error.
  const parsed = checkoutSessionIdSchema.safeParse(checkoutSessionId)
  try {
    return await djangoAction<{
      status: string
      plan: string
      trialDaysLeft: number | null
      locked: boolean
    }>("sync-stripe-subscription", {
      checkoutSessionId: parsed.success ? parsed.data : undefined,
    })
  } catch (cause) {
    return {
      error: actionErrorMessage(
        cause,
        "Couldn’t check your subscription. Try again."
      ),
    }
  }
}
