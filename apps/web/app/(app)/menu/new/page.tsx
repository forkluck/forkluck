import type { Metadata } from "next"

import { MenuChrome } from "@/components/menus/menu-chrome"
import { MenuEditor } from "@/components/menus/menu-editor"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getMenuSources, getSalesImports } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "New menu",
}

export default async function NewMenuPage() {
  const [user, source, salesImports] = await Promise.all([
    requireUser(),
    getMenuSources(),
    getSalesImports(),
  ])

  return (
    <Page variant="wide">
      <MenuChrome title="New menu">
        <MenuEditor
          initial={null}
          recipes={source.recipes}
          products={source.products}
          currencyCode={source.currencyCode}
          timeZone={salesImports[0]?.timezone ?? "UTC"}
          currentUserId={user.id}
        />
      </MenuChrome>
    </Page>
  )
}
