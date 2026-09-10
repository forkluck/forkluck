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
  searchParams: Promise<{ start?: string; end?: string; plan?: string }>
}) {
  await requireUser()
  const [{ menuId }, { start, end, plan }] = await Promise.all([
    params,
    searchParams,
  ])
  // Both dates or neither: a half range falls back to the default week
  // rather than guessing the other end.
  const range = start && end ? { start, end } : null
  const [forecast, settings] = await Promise.all([
    getMenuForecast(menuId, range, plan === "busy" ? "busy" : "typical"),
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
          selectedRange={range}
          measurementSystem={settings.measurementSystem}
        />
      </MenuChrome>
    </Page>
  )
}
