import type { Metadata } from "next"
import Link from "next/link"

import { MenusTable } from "@/components/menus/menus-table"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getMenus } from "@/lib/backend/queries"

export const metadata: Metadata = {
  title: "Menus",
}

export default async function MenusPage() {
  const [, result] = await Promise.all([requireUser(), getMenus()])

  return (
    <Page>
      <PageHeader>
        <PageTitle>Menus</PageTitle>
      </PageHeader>

      {!result.hasAnyMenu ? (
        <EmptyState
          title="No menus yet"
          description="Price a menu against its recipes: sell price and units sold on one side, food cost on the other, with margin and menu mix worked out for you."
        >
          <Link href="/menu/new" className={cn(buttonVariants())}>
            New menu
          </Link>
        </EmptyState>
      ) : (
        <MenusTable rows={result.menus} />
      )}
    </Page>
  )
}
