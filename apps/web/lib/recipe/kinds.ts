export const RECIPE_KINDS = ["recipe", "component"] as const

export type RecipeKind = (typeof RECIPE_KINDS)[number]

export const DEFAULT_RECIPE_KIND: RecipeKind = "recipe"

export const RECIPE_KIND_OPTIONS: Array<{
  value: RecipeKind
  label: string
  description: string
}> = [
  {
    value: "recipe",
    label: "Recipe",
    description: "A finished item you sell on its own",
  },
  {
    value: "component",
    label: "Component",
    description: "Used as an ingredient inside other recipes",
  },
]

export function recipeKindLabel(kind: RecipeKind | null): string {
  return (
    RECIPE_KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    "Recipe"
  )
}
