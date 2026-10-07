import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { SettingsScreen } from "@/components/settings/settings-screen"
import { getSession } from "@/lib/auth-session"
import {
  getAiCredential,
  getBusinessSettings,
} from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  const [session, businessSettings, credential] = await Promise.all([
    getSession(),
    getBusinessSettings(),
    getAiCredential(),
  ])
  if (!session) redirect("/login")

  // The credential read is loopback-only; only its status crosses into the
  // client component.
  return (
    <SettingsScreen
      user={session.user}
      billing={session.billing}
      businessSettings={businessSettings}
      aiKey={{ configured: credential.configured, hint: credential.hint }}
    />
  )
}
