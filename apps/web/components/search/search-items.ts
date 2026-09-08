import type { SearchIndexItem } from "@/lib/backend/types"

export type SearchItem = {
  label: string
  href: string
  /** "Go to" rows are the screens themselves; the rest come from the server. */
  group: "Go to" | "Recipes" | "Ingredients"
  meta?: string
}

export function toSearchItems(items: SearchIndexItem[]): SearchItem[] {
  return items.map((item) => ({
    label: item.label,
    href: item.href,
    group: item.type === "recipe" ? "Recipes" : "Ingredients",
  }))
}
