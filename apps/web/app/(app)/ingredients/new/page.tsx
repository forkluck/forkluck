import type { Metadata } from "next"

import { IngredientChrome } from "@/components/ingredients/ingredient-chrome"
import { NewIngredientPanel } from "@/components/ingredients/ingredient-panels"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import {
  getIngredientTags,
  getIngredientCategories,
} from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Add ingredient" }

export default async function NewIngredientPage() {
  const [, availableTags, categories] = await Promise.all([
    requireUser(),
    getIngredientTags(),
    getIngredientCategories(),
  ])

  return (
    <Page>
      <IngredientChrome name="New ingredient">
        <NewIngredientPanel
          availableTags={availableTags}
          categoryOptions={categories.map((category) => category.name)}
        />
      </IngredientChrome>
    </Page>
  )
}
