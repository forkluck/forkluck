import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"

import {
  CompareFormulas,
  type SavedComparisonState,
} from "@/components/recipes/compare-formulas"
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
  getSavedComparison,
} from "@/lib/backend/queries"
import { KITCHEN_COOKIE, resolveActiveKitchen } from "@/lib/kitchen"
import {
  COMPARE_PATH,
  parseCompareIds,
  savedFormulaInput,
  savedPastedKey,
} from "@/lib/recipe/compare"

export type CompareSearchParams = Promise<
  Record<string, string | string[] | undefined>
>

/**
 * Recipes side by side in baker's percentages: the screen behind both
 * `/recipes/compare/new` and a saved comparison's own address. The columns
 * are the public ids in `?r=`, or the record's columns when the URL names
 * no recipes; each is read with its nutrition rollup, which is where the
 * server weighs every line, so a viewer who cannot see cost still gets
 * grams. Recipes pasted from elsewhere are the browser's business, unless
 * they were saved with a comparison.
 */
export async function CompareScreen({
  searchParams,
  savedRef = null,
}: {
  searchParams: CompareSearchParams
  savedRef?: string | null
}) {
  const session = await getSession()
  if (!session) redirect("/login")
  const kitchen = resolveActiveKitchen(
    session,
    (await cookies()).get(KITCHEN_COOKIE)?.value
  )
  const params = await searchParams
  const record = savedRef ? await getSavedComparison(savedRef) : null
  // A saved comparison that answers nothing is gone or not this reader's.
  if (savedRef && !record) notFound()

  // What the URL says wins; the record fills in whatever it leaves out, so
  // the list can link to the bare address and later moves keep both in step.
  const savedRecipeIds =
    record?.columns.flatMap((column) =>
      column.recipe ? [column.recipe.publicId] : []
    ) ?? []
  const rawIds = singleSearchParam(params.r)
  const ids =
    rawIds !== undefined
      ? parseCompareIds(rawIds)
      : parseCompareIds(savedRecipeIds.join(","))
  const rawView = singleSearchParam(params.view)
  const view =
    rawView === "spec" || rawView === "formula"
      ? rawView
      : (record?.view ?? "formula")
  const savedBase =
    record && record.baselinePosition !== null
      ? (() => {
          const column = record.columns[record.baselinePosition]
          if (!column) return null
          return column.recipe
            ? column.recipe.publicId
            : savedPastedKey(column.position)
        })()
      : null
  const rawBase = singleSearchParam(params.base)
  const requestedBase = rawBase !== undefined ? rawBase || null : savedBase
  const baseId =
    requestedBase &&
    (ids.includes(requestedBase) || requestedBase.startsWith("paste:"))
      ? requestedBase
      : null

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
  const saved: SavedComparisonState | null = record
    ? {
        id: record.id,
        publicId: record.publicId,
        title: record.title,
        editVersion: record.editVersion,
        missingCount: record.missingCount,
        pasted: record.columns.flatMap((column) =>
          column.recipe
            ? []
            : [
                {
                  id: `saved-${column.position}`,
                  title: column.pastedTitle,
                  text: column.pastedText,
                },
              ]
        ),
      }
    : null

  return (
    <Page>
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/recipes">Recipes</PageParent>
            <PageParent href={COMPARE_PATH}>Compare</PageParent>
          </PageParents>
          <PageTitle>{saved ? saved.title : "New comparison"}</PageTitle>
        </div>
      </PageHeader>
      <CompareFormulas
        selected={loaded.map(({ recipe }) => recipe.publicId)}
        formulas={formulas}
        missingCount={ids.length - loaded.length + (saved?.missingCount ?? 0)}
        identities={identities}
        view={view}
        baseId={baseId}
        saved={saved}
        recipeOptions={browse.items.map(({ publicId, title, category }) => ({
          publicId,
          title,
          category,
        }))}
      />
    </Page>
  )
}
