import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { getSession } from "@/lib/auth-session"
import { billingLocked, onFreePlan } from "@/lib/billing"

import { SubscribeCard } from "./subscribe-card"

export const metadata: Metadata = {
  title: "Subscribe",
}

export default async function SubscribePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (!onFreePlan(session.billing) && !billingLocked(session.billing))
    redirect("/")

  return (
    <SubscribeCard
      email={session.user.email}
      firstSubscription={session.billing.status === "none"}
      canReturn={!billingLocked(session.billing)}
    />
  )
}
