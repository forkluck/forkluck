import type { SearchIndexItem } from "@/lib/backend/types"

export type SearchItem = {
  label: string
  href: string
  group: "Recipes" | "Ingredients"
  meta?: string
}

export function toSearchItems(items: SearchIndexItem[]): SearchItem[] {
  return items.map((item) => ({
    label: item.label,
    href: item.href,
    group: item.type === "recipe" ? "Recipes" : "Ingredients",
  }))
}
