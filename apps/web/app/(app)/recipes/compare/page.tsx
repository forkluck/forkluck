import type { Metadata } from "next"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { CompareFormulas } from "@/components/recipes/compare-formulas"
import {
  Page,
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { getSession } from "@/lib/auth-session"
import { singleSearchParam } from "@/lib/backend/pagination"
import {
  browseRecipes,
  getPricingEntries,
  getRecipe,
  getRecipeNutrition,
} from "@/lib/backend/queries"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import { parseCompareIds, savedFormulaInput } from "@/lib/recipe/compare"

export const metadata: Metadata = {
  title: "Compare recipes",
}

/**
 * Recipes side by side in baker's percentages. The saved columns are the
 * public ids in `?r=`; each is read with its nutrition rollup, which is
 * where the server weighs every line, so a viewer who cannot see cost still
 * gets grams. Recipes pasted from elsewhere are the browser's business.
 */
export default async function CompareRecipesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await getSession()
  if (!session) redirect("/login")
  const kitchen = resolveActiveKitchen(
    session,
    (await cookies()).get(KITCHEN_COOKIE)?.value
  )
  const params = await searchParams
  const ids = parseCompareIds(singleSearchParam(params.r))
  const [browse, ...pairs] = await Promise.all([
    browseRecipes({
      limit: 100,
      filters: { status: "active", kitchen: kitchen?.ownerId ?? null },
    }),
    ...ids.map((id) => Promise.all([getRecipe(id), getRecipeNutrition(id)])),
  ])
  // An id that answers nothing is a recipe this reader cannot open, or one
  // that is gone; the page says how many and shows the rest.
  const loaded = pairs.flatMap(([recipe, nutrition]) =>
    recipe ? [{ recipe, nutrition }] : []
  )
  // The pantry weighs pasted lines and names what is in them. It is the
  // owner's, so it is read only when every column is one the reader may
  // cost, the way the recipe tab decides.
  const sources =
    loaded.length > 0 && loaded.every(({ recipe }) => recipe.canViewCost)
      ? await getPricingEntries()
      : { items: [], recipes: [] }
  const identities = sources.items.filter((entry) => !entry.nonEdible)
  const formulas = loaded.map(({ recipe, nutrition }) =>
    savedFormulaInput(recipe, nutrition, identities)
  )

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
      <CompareFormulas
        selected={loaded.map(({ recipe }) => recipe.publicId)}
        formulas={formulas}
        missingCount={ids.length - loaded.length}
        identities={identities}
        recipeOptions={browse.items.map(({ publicId, title }) => ({
          publicId,
          title,
        }))}
      />
    </Page>
  )
}
