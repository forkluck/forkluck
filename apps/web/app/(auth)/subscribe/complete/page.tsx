import type { Metadata } from "next"

import { ConfirmSubscription } from "./confirm-subscription"

export const metadata: Metadata = {
  title: "Subscribe",
}

export default async function SubscribeCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  // Stripe redirects here before its webhook necessarily lands, so the page
  // syncs the checkout session itself rather than waiting for the webhook.
  const { session_id: sessionId } = await searchParams

  return <ConfirmSubscription sessionId={sessionId} />
}
