import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { IngredientChrome } from "@/components/ingredients/ingredient-chrome"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getIngredient } from "@/lib/backend/queries"

// `getIngredient` is React-cached, so the title and the layout below share
// the one read.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ingredientId: string }>
}): Promise<Metadata> {
  const { ingredientId } = await params
  const ingredient = await getIngredient(ingredientId)
  return { title: ingredient?.nonEdible ? "Supply" : "Ingredient" }
}

export default async function IngredientLayout({
  params,
  children,
}: {
  params: Promise<{ ingredientId: string }>
  children: React.ReactNode
}) {
  const { ingredientId } = await params
  const [, ingredient] = await Promise.all([
    requireUser(),
    getIngredient(ingredientId),
  ])
  if (!ingredient) notFound()

  return (
    <Page>
      <IngredientChrome
        id={ingredient.id}
        name={ingredient.name}
        publicId={ingredient.publicId}
        status={ingredient.status}
        nonEdible={ingredient.nonEdible}
        invoicePrices={ingredient.invoicePrices}
      >
        {children}
      </IngredientChrome>
    </Page>
  )
}
