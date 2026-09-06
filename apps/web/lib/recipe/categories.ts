export const MAX_RECIPE_CATEGORY_LENGTH = 64

export type RecipeCategory = string

const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  bread: "Bread",
  pastry: "Pastry",
  "cake-dessert": "Cake & dessert",
  cookies: "Cookies",
  savory: "Savory",
  "sauces-condiments": "Sauces & condiments",
  beverage: "Beverage",
  component: "Component",
  other: "Other",
}

export function recipeCategoryLabel(category: RecipeCategory | null): string {
  if (!category) return "Uncategorized"
  return LEGACY_CATEGORY_LABELS[category] ?? category
}
