import type { Metadata } from "next"

import { ProductEditor } from "@/components/menu/product-editor"
import { requireUser } from "@/lib/auth-session"
import { getMenuSources, getProductCategories } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Add product" }

export default async function NewProductPage() {
  const [, sources, categories] = await Promise.all([
    requireUser(),
    getMenuSources(),
    getProductCategories(),
  ])

  return (
    <ProductEditor
      product={null}
      recipes={sources.recipes}
      ingredients={sources.ingredients}
      products={sources.products}
      categories={categories}
    />
  )
}
