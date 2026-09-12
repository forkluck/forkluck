import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { BusinessSettingsProvider } from "@/components/business-settings-provider"
import { getSession } from "@/lib/auth-session"
import { getBusinessSettings } from "@/lib/backend/queries"
import { billingLocked, readOnlyNotice } from "@/lib/billing"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import { primoAvailable } from "@/lib/primo/access"
import { kitchenToolDescriptors } from "@/lib/primo/kitchen-tools"

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession()
  if (!session) redirect("/login")
  if (billingLocked(session.billing)) redirect("/subscribe")
  const user = session.user
  const [businessSettings, cookieStore] = await Promise.all([
    getBusinessSettings(),
    cookies(),
  ])
  // Pages re-resolve this from the cached session; the sidebar takes it as a
  // prop rather than a provider, because it is the only client that needs it.
  const kitchen = resolveActiveKitchen(
    session,
    cookieStore.get(KITCHEN_COOKIE)?.value
  )

  return (
    <BusinessSettingsProvider settings={businessSettings}>
      <AppShell
        user={user}
        kitchen={kitchen}
        kitchens={session.kitchens}
        primoEnabled={primoAvailable(session.billing)}
        webmcpTools={kitchenToolDescriptors()}
        readOnlyNotice={readOnlyNotice(session.billing)}
      >
        {children}
      </AppShell>
    </BusinessSettingsProvider>
  )
}
