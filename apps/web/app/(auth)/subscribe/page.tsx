import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { getSession } from "@/lib/auth-session"
import { billingLocked } from "@/lib/billing"

import { SubscribeCard, type SubscribeState } from "./subscribe-card"

export const metadata: Metadata = {
  title: "Subscribe",
}

export default async function SubscribePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const { billing } = session
  if (billing.plan === "paid" && !billingLocked(billing)) redirect("/")

  // Never subscribed means the trial is what is running or ran out; anything
  // else is a subscription that ended.
  const state: SubscribeState =
    billing.status !== "none"
      ? "lapsed"
      : billing.plan === "trial"
        ? "trial"
        : "trialEnded"

  return (
    <SubscribeCard
      email={session.user.email}
      state={state}
      trialDaysLeft={billing.trialDaysLeft}
      canReturn={!billingLocked(billing)}
    />
  )
}
