/**
 * Ingredients a cook weighs to the tenth of a gram. Salt, leaveners, spices,
 * hydrocolloids, extracts: a scaled batch prints "10.3 g" of these, while
 * flour or stock print a whole number. Matched on the ingredient's name, and
 * on its category name when the kitchen has one.
 */
const PRECISE_NAME = new RegExp(
  [
    // Salts and cures
    "\\bsalt\\b",
    "fleur de sel",
    "sel gris",
    "prague powder",
    "\\bcure\\b",
    "nitrite",
    "nitrate",
    "\\bmsg\\b",
    "monosodium glutamate",
    // Pepper and chilli, as a seasoning rather than a vegetable
    "black pepper",
    "white pepper",
    "pink pepper",
    "peppercorn",
    "ground pepper",
    "cracked pepper",
    "pepper flakes",
    "chill?i flakes",
    "cayenne",
    "chill?[ie] powder",
    "paprika",
    // Spices and dried herbs
    "cinnamon",
    "nutmeg",
    "\\bmace\\b",
    "(?<!garlic )\\bcloves?\\b",
    "cardamom",
    "\\bcumin\\b",
    "coriander seed",
    "ground coriander",
    "turmeric",
    "ground ginger",
    "ginger powder",
    "allspice",
    "\\banise\\b",
    "fennel seed",
    "caraway",
    "mustard seed",
    "mustard powder",
    "dry mustard",
    "saffron",
    "\\bsumac\\b",
    "za'?atar",
    "curry powder",
    "garam masala",
    "five.?spice",
    "ras el hanout",
    "berbere",
    "old bay",
    "garlic powder",
    "onion powder",
    "celery seed",
    "juniper",
    "bay lea(f|ves)",
    "dried (oregano|thyme|rosemary|basil|tarragon|marjoram|sage|dill|mint|parsley|chives|herbs?)",
    "ground (oregano|thyme|rosemary|sage)",
    // Leaveners
    "\\byeast\\b",
    "baking soda",
    "baking powder",
    "bicarbonate",
    "cream of tartar",
    "baker'?s ammonia",
    "ammonium (bi)?carbonate",
    // Hydrocolloids, acids and other additives
    "xanthan",
    "\\bguar\\b",
    "gellan",
    "\\bagar\\b",
    "gelatine?",
    "pectin",
    "carrageenan",
    "locust bean",
    "tara gum",
    "methylcellulose",
    "lecithin",
    "alginate",
    "sodium citrate",
    "calcium chloride",
    "calcium lactate",
    "citric acid",
    "malic acid",
    "tartaric acid",
    "ascorbic acid",
    "lactic acid",
    "transglutaminase",
    "potassium sorbate",
    "sodium benzoate",
    "glucono",
    // Extracts, colours and enzymes
    "extract",
    "essence",
    "food colou?r",
    "gel colou?r",
    "flavou?ring",
    "enzyme",
    "lipase",
    "diastatic",
    "malt powder",
  ].join("|"),
  "i"
)

const PRECISE_CATEGORY =
  /spice|seasoning|additive|leaven|hydrocolloid|extract|flavou?r/i

export function isPreciseIngredient(
  name: string | null | undefined,
  category?: string | null
): boolean {
  return (
    (!!name && PRECISE_NAME.test(name)) ||
    (!!category && PRECISE_CATEGORY.test(category))
  )
}

/** The decimals a quantity of this ingredient shows: one for a precise
 * ingredient, none for everything else. */
export function precisionFor(
  name: string | null | undefined,
  category?: string | null
): number {
  return isPreciseIngredient(name, category) ? 1 : 0
}
