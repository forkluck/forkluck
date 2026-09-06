import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { MenuChrome } from "@/components/menus/menu-chrome"
import { MenuMatrix } from "@/components/menus/menu-matrix"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getMenu } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Menu matrix",
}

export default async function MenuMatrixPage({
  params,
}: {
  params: Promise<{ menuId: string }>
}) {
  await requireUser()
  const { menuId } = await params
  const detail = await getMenu(menuId)
  if (!detail) notFound()

  return (
    <Page variant="wide">
      <MenuChrome
        title={detail.menu.name}
        publicId={detail.menu.publicId}
        editable={false}
      >
        <MenuMatrix
          items={detail.items}
          currencyCode={detail.currencyCode}
          periodStart={detail.menu.periodStart}
          periodEnd={detail.menu.periodEnd}
        />
      </MenuChrome>
    </Page>
  )
}
