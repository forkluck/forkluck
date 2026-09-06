import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { MenuChrome } from "@/components/menus/menu-chrome"
import { MenuEditor } from "@/components/menus/menu-editor"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getMenu, getSalesImports } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Menu",
}

export default async function MenuDetailPage({
  params,
}: {
  params: Promise<{ menuId: string }>
}) {
  const user = await requireUser()
  const { menuId } = await params
  const [detail, salesImports] = await Promise.all([
    getMenu(menuId),
    getSalesImports(),
  ])
  if (!detail) notFound()

  return (
    <Page variant="wide">
      <MenuChrome title={detail.menu.name} publicId={detail.menu.publicId}>
        <MenuEditor
          key={detail.menu.id}
          initial={detail}
          recipes={detail.recipes}
          products={detail.products}
          currencyCode={detail.currencyCode}
          timeZone={salesImports[0]?.timezone ?? "UTC"}
          currentUserId={user.id}
        />
      </MenuChrome>
    </Page>
  )
}
