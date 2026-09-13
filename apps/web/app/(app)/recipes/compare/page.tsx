import type { Metadata } from "next"
import Link from "next/link"

import { SavedComparisonsTable } from "@/components/recipes/saved-comparisons-table"
import { buttonVariants } from "@/components/ui/button"
import {
  EmptyState,
  Page,
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getSavedComparisons } from "@/lib/backend/queries"
import { COMPARE_NEW_PATH } from "@/lib/recipe/compare"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Compare recipes",
}

/** The comparisons this account has kept, by name; a new one starts at /new. */
export default async function ComparisonsPage() {
  const [, result] = await Promise.all([requireUser(), getSavedComparisons()])

  return (
    <Page>
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/recipes">Recipes</PageParent>
          </PageParents>
          <PageTitle>Compare</PageTitle>
        </div>
      </PageHeader>

      {result.comparisons.length === 0 ? (
        <EmptyState
          title="No saved comparisons yet"
          description="Read recipes side by side in baker's percentages, or as composition, and keep a comparison by name to come back to."
        >
          <Link href={COMPARE_NEW_PATH} className={cn(buttonVariants())}>
            New comparison
          </Link>
        </EmptyState>
      ) : (
        <SavedComparisonsTable rows={result.comparisons} />
      )}
    </Page>
  )
}
