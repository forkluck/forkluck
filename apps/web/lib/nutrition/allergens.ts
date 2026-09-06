/**
 * The kitchen allergen tags, in the order the backend declares them
 * (`Allergen` in apps/api/forkluck/models.py). The first nine are the US
 * major allergens; the next five complete the EU Annex II list; the last
 * four are sensitivities kitchens track but no label regulates.
 */
export const ALLERGENS = [
  { key: "milk", label: "Milk" },
  { key: "egg", label: "Egg" },
  { key: "fish", label: "Fish" },
  { key: "shellfish", label: "Crustacean shellfish" },
  { key: "tree_nuts", label: "Tree nuts" },
  { key: "peanut", label: "Peanut" },
  { key: "wheat", label: "Wheat" },
  { key: "soy", label: "Soy" },
  { key: "sesame", label: "Sesame" },
  { key: "sulphites", label: "Sulphites" },
  { key: "gluten_cereals", label: "Cereals containing gluten" },
  { key: "mollusks", label: "Mollusks" },
  { key: "mustard", label: "Mustard" },
  { key: "lupin", label: "Lupin" },
  { key: "celery", label: "Celery" },
  { key: "allium", label: "Allium" },
  { key: "nightshades", label: "Nightshades" },
  { key: "legumes", label: "Legumes" },
  { key: "stone_fruit", label: "Stone fruit" },
] as const

export type AllergenKey = (typeof ALLERGENS)[number]["key"]
export type AllergenStatus = "contains" | "mayContain" | "doesNotContain"

export const ALLERGEN_KEYS = ALLERGENS.map((entry) => entry.key) as [
  AllergenKey,
  ...AllergenKey[],
]

/** The tags a US label's CONTAINS line declares. */
export const US_DECLARED: ReadonlySet<AllergenKey> = new Set<AllergenKey>([
  "milk",
  "egg",
  "fish",
  "shellfish",
  "tree_nuts",
  "peanut",
  "wheat",
  "soy",
  "sesame",
])

/** The tags an EU label emphasises in its ingredient list. Wheat is on it
 * as a named gluten cereal. */
export const EU_DECLARED: ReadonlySet<AllergenKey> = new Set<AllergenKey>([
  "milk",
  "egg",
  "fish",
  "shellfish",
  "tree_nuts",
  "peanut",
  "wheat",
  "soy",
  "sesame",
  "sulphites",
  "gluten_cereals",
  "mollusks",
  "mustard",
  "lupin",
  "celery",
])

export function allergenLabel(key: string): string {
  return ALLERGENS.find((entry) => entry.key === key)?.label ?? key
}

/** Sensitivities kitchens track that no label regulates. */
export const KITCHEN_ONLY: ReadonlySet<AllergenKey> = new Set<AllergenKey>([
  "allium",
  "nightshades",
  "legumes",
  "stone_fruit",
])

/** The tags a region's label declares. */
export function declaredAllergenKeys(
  region: "us" | "eu"
): ReadonlySet<AllergenKey> {
  return region === "eu" ? EU_DECLARED : US_DECLARED
}
