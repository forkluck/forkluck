import { INGREDIENT_PROFILES } from "./data"
import type {
  CompositionValues,
  IngredientProfile,
  RecipeAnalysis,
  RecipeCategory,
  RecipeIngredientInput,
  RecipeSignal,
  SignalStatus,
  SolidKey,
} from "./types"

const solidMeta: Array<{ key: SolidKey; label: string; color: string }> = [
  { key: "starch", label: "Starch", color: "#18181b" },
  { key: "protein", label: "Protein", color: "#3f3f46" },
  { key: "fat", label: "Fat", color: "#52525b" },
  { key: "fiber", label: "Fiber", color: "#71717a" },
  { key: "sugars", label: "Sugars", color: "#a1a1aa" },
  { key: "salt", label: "Salt", color: "#d4d4d8" },
  { key: "other", label: "Other", color: "#e4e4e7" },
]

function emptySolids(): CompositionValues {
  return {
    fat: 0,
    protein: 0,
    sugars: 0,
    starch: 0,
    fiber: 0,
    salt: 0,
    other: 0,
  }
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(
      /\((?:sifted|chopped|minced|divided|melted|softened|room temperature|\d+\s*°?\s*[cf])\)/g,
      " "
    )
    .trim()
    .replace(
      /^\d+(?:\.\d+|\/\d+)?\s*(?:g|kg|grams?|kilograms?|oz|ounces?|lb|pounds?|cups?|tbsp|tablespoons?|tsp|teaspoons?)\s+/,
      ""
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

const profileNames = INGREDIENT_PROFILES.flatMap((profile) =>
  [profile.name, ...profile.aliases].map((alias) => ({
    alias: normalizeName(alias),
    profile,
  }))
).sort((a, b) => b.alias.length - a.alias.length)

// The parser peels size words before matching; callers passing raw line names
// (nutrition attribution) need the same peel or "3 large eggs" loses its
// profile. Duplicated from the parser to avoid an import cycle.
const leadingSizePattern = /^(?:extra[- ]large|small|medium|large|jumbo)\s+/i

export function findIngredientProfile(name: string): IngredientProfile | null {
  const normalized = normalizeName(name.replace(leadingSizePattern, ""))
  if (!normalized) return null

  const exact = profileNames.find(({ alias }) => alias === normalized)
  return exact?.profile ?? null
}

type RangeRule = {
  label: string
  key: RecipeSignal["key"]
  value: number | null
  green: [number, number]
  yellow: [number, number]
  scale: [number, number]
  basis: string
}

function signalStatus(
  value: number,
  green: [number, number],
  yellow: [number, number]
): SignalStatus {
  if (value >= green[0] && value <= green[1]) return "balanced"
  if (value >= yellow[0] && value <= yellow[1]) return "watch"
  return "outside"
}

function signalFromRule(rule: RangeRule): RecipeSignal {
  if (rule.value === null) {
    return {
      key: rule.key,
      label: rule.label,
      value: null,
      unit: "",
      status: "unknown",
      position: 0,
      scaleMin: 0,
      scaleMax: 100,
      targetMin: 0,
      targetMax: 0,
      targetStart: 0,
      targetEnd: 0,
      summary: "No benchmark",
      basis: rule.basis,
    }
  }

  const displayValue = round(rule.value)
  const status = signalStatus(displayValue, rule.green, rule.yellow)
  const position = Math.min(
    100,
    Math.max(
      0,
      ((rule.value - rule.scale[0]) / (rule.scale[1] - rule.scale[0])) * 100
    )
  )
  const targetStart =
    ((rule.green[0] - rule.scale[0]) / (rule.scale[1] - rule.scale[0])) * 100
  const targetEnd =
    ((rule.green[1] - rule.scale[0]) / (rule.scale[1] - rule.scale[0])) * 100

  const summary =
    status === "balanced"
      ? "Within prototype band"
      : displayValue < rule.green[0]
        ? `${rule.label} below prototype band`
        : `${rule.label} above prototype band`

  return {
    key: rule.key,
    label: rule.label,
    value: displayValue,
    unit: "% flour",
    status,
    position: round(position),
    scaleMin: rule.scale[0],
    scaleMax: rule.scale[1],
    targetMin: rule.green[0],
    targetMax: rule.green[1],
    targetStart: round(Math.min(100, Math.max(0, targetStart))),
    targetEnd: round(Math.min(100, Math.max(0, targetEnd))),
    summary,
    basis: rule.basis,
  }
}

function unknownSignals(reason: string): RecipeSignal[] {
  return (
    [
      ["hydration", "Hydration"],
      ["fat", "Fat"],
      ["sugar", "Sweetener"],
      ["salt", "Salt"],
    ] as const
  ).map(([key, label]) => ({
    key,
    label,
    value: null,
    unit: "",
    status: "unknown",
    position: 0,
    scaleMin: 0,
    scaleMax: 100,
    targetMin: 0,
    targetMax: 0,
    targetStart: 0,
    targetEnd: 0,
    summary: "No benchmark",
    basis: reason,
  }))
}

export function inferRecipeCategory(
  ingredients: RecipeIngredientInput[]
): RecipeCategory {
  const profiles = ingredients
    .filter(
      ({ grams, isComponent }) =>
        !isComponent && Number.isFinite(grams) && grams > 0
    )
    .map(({ name }) => findIngredientProfile(name))
    .filter((profile): profile is IngredientProfile => profile !== null)

  const profileKeys = new Set(profiles.map(({ key }) => key))
  const hasFlour = profiles.some(({ role }) => role === "flour")
  const hasFat = profiles.some(({ role }) => role === "fat")
  const hasSweetener = profiles.some(({ role }) => role === "sweetener")

  if (hasFlour && profileKeys.has("instant-yeast")) return "bread"

  if (
    hasFlour &&
    (profileKeys.has("baking-powder") ||
      (profileKeys.has("egg") && hasFat && hasSweetener))
  ) {
    return "cake"
  }

  return "general"
}

export function analyzeRecipe(
  ingredients: RecipeIngredientInput[],
  requestedCategory?: RecipeCategory
): RecipeAnalysis {
  const category = requestedCategory ?? inferRecipeCategory(ingredients)
  const validIngredients = ingredients.filter(
    (ingredient) =>
      ingredient.name.trim() &&
      Number.isFinite(ingredient.grams) &&
      ingredient.grams > 0
  )
  const totalMassG = validIngredients.reduce(
    (sum, ingredient) => sum + ingredient.grams,
    0
  )
  const totals = emptySolids()
  const matchedIngredients: RecipeAnalysis["matchedIngredients"] = []
  const unknownIngredients: RecipeAnalysis["unknownIngredients"] = []
  let knownMassG = 0
  let waterG = 0
  let flourMassG = 0
  let hydrationWaterG = 0
  let sweetenerSugarG = 0
  let addedSaltG = 0
  let totalCarbohydrateG = 0
  let sodiumMg = 0
  let saturatedFatG = 0

  for (const ingredient of validIngredients) {
    // A component is a sub-recipe, not a pantry ingredient, so it never takes
    // a built-in profile even when its title matches one. It stays unmapped
    // and reduces coverage honestly rather than borrowing raw macros.
    const seedProfile = ingredient.isComponent
      ? null
      : findIngredientProfile(ingredient.name)
    const profile = ingredient.nutritionPer100g
      ? {
          key: `mapped:${ingredient.id}`,
          name: ingredient.name,
          aliases: [],
          role: seedProfile?.role ?? ("other" as const),
          water: ingredient.nutritionPer100g.water,
          solids: {
            fat: ingredient.nutritionPer100g.fat,
            protein: ingredient.nutritionPer100g.protein,
            sugars: ingredient.nutritionPer100g.sugars,
            starch: ingredient.nutritionPer100g.starch,
            fiber: ingredient.nutritionPer100g.fiber,
            salt: ingredient.nutritionPer100g.salt,
            other: ingredient.nutritionPer100g.other,
          },
        }
      : seedProfile
    if (!profile) {
      unknownIngredients.push({
        id: ingredient.id,
        name: ingredient.name,
        grams: ingredient.grams,
      })
      continue
    }

    knownMassG += ingredient.grams
    waterG += (ingredient.grams * profile.water) / 100
    if (profile.role === "flour") flourMassG += ingredient.grams
    if (profile.role === "hydration")
      hydrationWaterG += (ingredient.grams * profile.water) / 100
    if (profile.role === "sweetener")
      sweetenerSugarG += (ingredient.grams * profile.solids.sugars) / 100
    if (profile.role === "salt")
      addedSaltG += (ingredient.grams * profile.solids.salt) / 100

    const sourceComposition = ingredient.nutritionPer100g
    const totalCarbohydratePer100g =
      sourceComposition?.totalCarbohydrate ??
      profile.solids.sugars + profile.solids.starch + profile.solids.fiber
    const sodiumMgPer100g =
      sourceComposition?.sodiumMg ?? profile.solids.salt * 400
    totalCarbohydrateG += (ingredient.grams * totalCarbohydratePer100g) / 100
    sodiumMg += (ingredient.grams * sodiumMgPer100g) / 100
    // Saturates have no fallback: the saturated share of fat runs from about
    // 14% in olive oil to 63% in butter, so a built-in profile's total fat
    // implies nothing about it. Only records that report it contribute.
    saturatedFatG +=
      (ingredient.grams * (sourceComposition?.saturatedFat ?? 0)) / 100

    for (const key of Object.keys(totals) as SolidKey[]) {
      totals[key] += (ingredient.grams * profile.solids[key]) / 100
    }

    matchedIngredients.push({
      id: ingredient.id,
      inputName: ingredient.name,
      canonicalName: profile.name,
      grams: ingredient.grams,
      profileKey: profile.key,
    })
  }

  const dryMatterG = Object.values(totals).reduce(
    (sum, value) => sum + value,
    0
  )
  const analyzedMassG = waterG + dryMatterG
  const waterPercent = analyzedMassG > 0 ? (waterG / analyzedMassG) * 100 : 0
  const dryMatterPercent =
    analyzedMassG > 0 ? (dryMatterG / analyzedMassG) * 100 : 0
  const coveragePercent = totalMassG > 0 ? (knownMassG / totalMassG) * 100 : 0
  const per100Factor = knownMassG > 0 ? 100 / knownMassG : 0

  const solids = solidMeta.map(({ key, label, color }) => ({
    key,
    label,
    grams: round(totals[key]),
    percentOfDryMatter: round(
      dryMatterG > 0 ? (totals[key] / dryMatterG) * 100 : 0
    ),
    color,
  }))

  let signals: RecipeSignal[]
  if ((category === "bread" || category === "cake") && flourMassG <= 0) {
    signals = unknownSignals(
      "Add a mapped flour ingredient to calculate baker’s percentages."
    )
  } else if (category === "bread") {
    const pct = (grams: number) => (grams / flourMassG) * 100
    const fatG = totals.fat
    const rules: RangeRule[] = [
      {
        key: "hydration",
        label: "Hydration",
        value: pct(hydrationWaterG),
        green: [65, 85],
        yellow: [55, 95],
        scale: [40, 110],
        basis:
          "Bread benchmark: 65–85% water from mapped hydration ingredients, relative to flour weight.",
      },
      {
        key: "fat",
        label: "Fat",
        value: pct(fatG),
        green: [0, 10],
        yellow: [0, 16],
        scale: [0, 24],
        basis:
          "Bread benchmark: up to 10% calculated fat relative to flour weight; enriched doughs may be higher.",
      },
      {
        key: "sugar",
        label: "Sweetener",
        value: pct(sweetenerSugarG),
        green: [0, 5],
        yellow: [0, 12],
        scale: [0, 20],
        basis:
          "Bread benchmark: up to 5% sugar from mapped sweetener ingredients, relative to flour weight.",
      },
      {
        key: "salt",
        label: "Salt",
        value: pct(addedSaltG),
        green: [1.5, 2.5],
        yellow: [1, 3],
        scale: [0, 4],
        basis: "Bread benchmark: 1.5–2.5% added salt relative to flour weight.",
      },
    ]
    signals = rules.map(signalFromRule)
  } else if (category === "cake") {
    const pct = (grams: number) => (grams / flourMassG) * 100
    const formulationOnly =
      "These broad bands compare formula structure; they are not a quality or nutrition judgment."
    const rules: RangeRule[] = [
      {
        key: "hydration",
        label: "Moisture",
        value: pct(waterG),
        green: [25, 125],
        yellow: [15, 160],
        scale: [0, 180],
        basis: `Cake/batter prototype: 25–125% calculated water from all mapped ingredients, relative to mapped flour weight. ${formulationOnly}`,
      },
      {
        key: "fat",
        label: "Fat",
        value: pct(totals.fat),
        green: [20, 110],
        yellow: [0, 130],
        scale: [0, 150],
        basis: `Cake/batter prototype: 20–110% calculated fat from all mapped ingredients, relative to mapped flour weight. ${formulationOnly}`,
      },
      {
        key: "sugar",
        label: "Sugar",
        value: pct(sweetenerSugarG),
        green: [80, 125],
        yellow: [50, 150],
        scale: [0, 170],
        basis: `Cake/batter prototype: 80–125% sugar from mapped sweetener ingredients, relative to mapped flour weight. ${formulationOnly}`,
      },
      {
        key: "salt",
        label: "Salt",
        value: pct(addedSaltG),
        green: [0.5, 1.5],
        yellow: [0.25, 2],
        scale: [0, 2.5],
        basis: `Cake/batter prototype: 0.5–1.5% added salt relative to mapped flour weight. ${formulationOnly}`,
      },
    ]
    signals = rules.map(signalFromRule)
  } else {
    signals = unknownSignals(
      "Formulation ranges are currently available for bread, dough, cake, and batter only."
    )
  }

  const caveats = [
    "This is a raw-batch formulation estimate; fermentation, evaporation, cooking loss, and final yield are not modeled.",
    "Seed ingredient values are representative and are not a substitute for a verified nutrient database.",
  ]
  if (unknownIngredients.length) {
    caveats.unshift(
      `${unknownIngredients.length} ingredient${unknownIngredients.length === 1 ? " is" : "s are"} excluded from composition until mapped.`
    )
  }

  return {
    totalMassG: round(totalMassG),
    knownMassG: round(knownMassG),
    coveragePercent: round(coveragePercent),
    waterG: round(waterG),
    waterPercent: round(waterPercent),
    dryMatterG: round(dryMatterG),
    dryMatterPercent: round(dryMatterPercent),
    flourMassG: round(flourMassG),
    solids,
    nutritionTotals: {
      water: round(waterG, 4),
      fat: round(totals.fat, 4),
      protein: round(totals.protein, 4),
      sugars: round(totals.sugars, 4),
      starch: round(totals.starch, 4),
      fiber: round(totals.fiber, 4),
      salt: round(totals.salt, 4),
      other: round(totals.other, 4),
      totalCarbohydrate: round(totalCarbohydrateG, 4),
      sodiumMg: round(sodiumMg, 4),
      saturatedFat: round(saturatedFatG, 4),
    },
    per100g: {
      water: round(waterG * per100Factor),
      dryMatter: round(dryMatterG * per100Factor),
      fat: round(totals.fat * per100Factor),
      protein: round(totals.protein * per100Factor),
      sugars: round(totals.sugars * per100Factor),
      starch: round(totals.starch * per100Factor),
      fiber: round(totals.fiber * per100Factor),
      salt: round(totals.salt * per100Factor),
      other: round(totals.other * per100Factor),
    },
    signals,
    matchedIngredients,
    unknownIngredients,
    caveats,
  }
}
