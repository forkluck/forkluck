import "server-only"

import type { BillingState } from "@/lib/billing"
import { primoConfigured } from "@/lib/primo/model"

// Primo runs on a paid entitlement: its tokens cost real money per message.
export function primoAvailable(billing: BillingState): boolean {
  if (!primoConfigured()) return false
  if (process.env.NODE_ENV !== "production") return true
  return billing.entitlements.primo
}
