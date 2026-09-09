import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { MenuChrome } from "@/components/menus/menu-chrome"
import { MenuForecast } from "@/components/menus/menu-forecast"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getBusinessSettings, getMenuForecast } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Production forecast",
}

export default async function MenuForecastPage({
  params,
  searchParams,
}: {
  params: Promise<{ menuId: string }>
  searchParams: Promise<{ days?: string; plan?: string; view?: string }>
}) {
  await requireUser()
  const [{ menuId }, { days, plan, view }] = await Promise.all([
    params,
    searchParams,
  ])
  const [forecast, settings] = await Promise.all([
    getMenuForecast(
      menuId,
      days === "30" ? 30 : 7,
      plan === "busy" ? "busy" : "typical"
    ),
    getBusinessSettings(),
  ])
  if (!forecast) notFound()

  return (
    <Page variant="wide">
      <MenuChrome
        title={forecast.menu.name}
        publicId={forecast.menu.publicId}
        editable={false}
      >
        <MenuForecast
          forecast={forecast}
          view={view === "day" ? "day" : "week"}
          measurementSystem={settings.measurementSystem}
        />
      </MenuChrome>
    </Page>
  )
}
