import { describe, expect, it } from "vitest"

import {
  SAMPLE_RECIPE,
  analyzeRecipe,
  generalEnergyKcal,
  findIngredientProfile,
  inferRecipeCategory,
  parseRecipeText,
  recipeNutritionFacts,
  resolveNutritionIngredient,
} from "../lib/recipe"

describe("recipe analysis", () => {
  it("conserves mass and reports 100% water plus dry matter for the sample recipe", () => {
    const analysis = analyzeRecipe(SAMPLE_RECIPE.ingredients)

    expect(analysis.totalMassG).toBe(1067)
    expect(analysis.knownMassG).toBe(analysis.totalMassG)
    expect(analysis.coveragePercent).toBe(100)
    expect(analysis.waterG + analysis.dryMatterG).toBeCloseTo(
      analysis.totalMassG,
      1
    )
    expect(analysis.waterPercent + analysis.dryMatterPercent).toBe(100)
    expect(analysis.per100g.water + analysis.per100g.dryMatter).toBe(100)
  })

  it("infers formulation benchmarks from mapped ingredients", () => {
    expect(
      inferRecipeCategory([
        { id: "flour", name: "Bread flour", grams: 100 },
        { id: "yeast", name: "Instant yeast", grams: 1 },
      ])
    ).toBe("bread")

    expect(
      inferRecipeCategory([
        { id: "flour", name: "All-purpose flour", grams: 100 },
        { id: "leavener", name: "Baking powder", grams: 4 },
      ])
    ).toBe("cake")

    expect(
      inferRecipeCategory([
        { id: "flour", name: "All-purpose flour", grams: 100 },
        { id: "egg", name: "Eggs", grams: 50 },
        { id: "fat", name: "Butter", grams: 70 },
        { id: "sugar", name: "Sugar", grams: 100 },
      ])
    ).toBe("cake")

    expect(
      inferRecipeCategory([
        { id: "tomato", name: "Tomatoes", grams: 100 },
        { id: "oil", name: "Olive oil", grams: 10 },
      ])
    ).toBe("general")
  })

  it("maps normalized, quantity-prefixed, and explicitly descriptive vocabulary", () => {
    expect(
      findIngredientProfile("2 cups (sifted) STRONG-BREAD FLOUR")?.key
    ).toBe("bread-flour")
    expect(findIngredientProfile("extra-virgin olive oil")?.key).toBe(
      "olive-oil"
    )
    expect(findIngredientProfile("0.5 kg sugar")?.key).toBe("granulated-sugar")
    expect(findIngredientProfile("1/2 cup sugar")?.key).toBe("granulated-sugar")

    const analysis = analyzeRecipe([
      { id: "flour", name: "Stoneground plain flour", grams: 100 },
      { id: "water", name: "Warm water (38 C)", grams: 60 },
    ])

    expect(analysis.matchedIngredients).toEqual([
      expect.objectContaining({
        id: "flour",
        canonicalName: "Flour",
        profileKey: "all-purpose-flour",
      }),
      expect.objectContaining({
        id: "water",
        canonicalName: "Water",
        profileKey: "water",
      }),
    ])
  })

  it("counts saturated fat only from records that report it", () => {
    // A built-in profile carries total fat but no saturated share, and the
    // share is not derivable from it — butter runs about 63% saturated where
    // olive oil runs about 14%. Unreported saturates contribute nothing
    // rather than borrowing a figure from total fat.
    const mapped = analyzeRecipe([
      {
        id: "butter",
        name: "Butter",
        grams: 200,
        nutritionPer100g: {
          water: 16,
          fat: 81,
          protein: 1,
          sugars: 0,
          starch: 0,
          fiber: 0,
          salt: 0,
          other: 2,
          totalCarbohydrate: 0,
          sodiumMg: 11,
          saturatedFat: 51,
        },
      },
    ])
    const unmapped = analyzeRecipe([
      { id: "oil", name: "Olive oil", grams: 200 },
    ])

    expect(mapped.nutritionTotals.saturatedFat).toBe(102)
    expect(unmapped.nutritionTotals.fat).toBeGreaterThan(0)
    expect(unmapped.nutritionTotals.saturatedFat).toBe(0)
  })

  it("does not guess when a more specific ingredient has no profile", () => {
    expect(findIngredientProfile("tomato paste")).toBeNull()
    expect(findIngredientProfile("milk powder")).toBeNull()
    expect(findIngredientProfile("milk (skim)")).toBeNull()
    expect(findIngredientProfile("egg noodles")).toBeNull()
  })

  it("keeps salted and unsalted butter as distinct profiles", () => {
    const salted = findIngredientProfile("Salted butter")
    const unsalted = findIngredientProfile("Unsalted butter")

    expect(salted?.key).toBe("salted-butter")
    expect(unsalted?.key).toBe("unsalted-butter")
    expect(salted?.solids.salt).toBeGreaterThan(unsalted?.solids.salt ?? 0)
  })

  it("counts unknown mass in total mass but excludes it from composition coverage", () => {
    const knownIngredient = {
      id: "flour",
      name: "Bread flour",
      grams: 100,
    }
    const knownOnly = analyzeRecipe([knownIngredient])
    const withUnknown = analyzeRecipe([
      knownIngredient,
      { id: "mystery", name: "Moon dust", grams: 50 },
    ])

    expect(withUnknown.totalMassG).toBe(150)
    expect(withUnknown.knownMassG).toBe(100)
    expect(withUnknown.coveragePercent).toBe(66.7)
    expect(withUnknown.waterG).toBe(knownOnly.waterG)
    expect(withUnknown.dryMatterG).toBe(knownOnly.dryMatterG)
    expect(withUnknown.solids).toEqual(knownOnly.solids)
    expect(withUnknown.per100g).toEqual(knownOnly.per100g)
    expect(withUnknown.unknownIngredients).toEqual([
      { id: "mystery", name: "Moon dust", grams: 50 },
    ])
    expect(withUnknown.caveats[0]).toContain(
      "1 ingredient is excluded from composition"
    )
  })

  it("calculates baker percentages and assigns balanced, watch, and outside salt states", () => {
    const makeBread = (saltGrams: number) =>
      analyzeRecipe(
        [
          { id: "flour", name: "Bread flour", grams: 100 },
          { id: "water", name: "Water", grams: 70 },
          { id: "salt", name: "Salt", grams: saltGrams },
        ],
        "bread"
      )

    const balanced = makeBread(2)
    expect(balanced.flourMassG).toBe(100)
    expect(balanced.signals).toEqual([
      expect.objectContaining({
        key: "hydration",
        value: 70,
        status: "balanced",
      }),
      expect.objectContaining({ key: "fat", value: 1.5, status: "balanced" }),
      expect.objectContaining({ key: "sugar", value: 0, status: "balanced" }),
      expect.objectContaining({ key: "salt", value: 2, status: "balanced" }),
    ])

    expect(makeBread(3).signals.find(({ key }) => key === "salt")).toEqual(
      expect.objectContaining({
        value: 3,
        status: "watch",
        summary: "Salt above prototype band",
      })
    )
    expect(makeBread(2.54).signals.find(({ key }) => key === "salt")).toEqual(
      expect.objectContaining({ value: 2.5, status: "balanced" })
    )
    expect(makeBread(5).signals.find(({ key }) => key === "salt")).toEqual(
      expect.objectContaining({
        value: 5,
        status: "outside",
        position: 100,
        summary: "Salt above prototype band",
      })
    )

    const highSugar = analyzeRecipe(
      [
        { id: "flour", name: "Bread flour", grams: 100 },
        { id: "water", name: "Water", grams: 70 },
        { id: "sugar", name: "Granulated sugar", grams: 10 },
      ],
      "bread"
    )
    expect(highSugar.signals.find(({ key }) => key === "sugar")).toEqual(
      expect.objectContaining({
        value: 10,
        status: "watch",
        summary: "Sweetener above prototype band",
      })
    )
  })

  it("calculates broad prototype cake formulation signals from mapped flour mass", () => {
    const balanced = analyzeRecipe(
      [
        { id: "flour", name: "All-purpose flour", grams: 100 },
        { id: "water", name: "Water", grams: 60 },
        { id: "butter", name: "Butter", grams: 80 },
        { id: "sugar", name: "Sugar", grams: 100 },
        { id: "salt", name: "Salt", grams: 1 },
      ],
      "cake"
    )

    expect(balanced.flourMassG).toBe(100)
    expect(balanced.signals).toEqual([
      expect.objectContaining({
        key: "hydration",
        label: "Moisture",
        value: 84.7,
        status: "balanced",
        targetMin: 25,
        targetMax: 125,
      }),
      expect.objectContaining({
        key: "fat",
        value: 65.9,
        status: "balanced",
        targetMin: 20,
        targetMax: 110,
      }),
      expect.objectContaining({
        key: "sugar",
        label: "Sugar",
        value: 100,
        status: "balanced",
        targetMin: 80,
        targetMax: 125,
      }),
      expect.objectContaining({
        key: "salt",
        value: 1,
        status: "balanced",
        targetMin: 0.5,
        targetMax: 1.5,
      }),
    ])
    for (const signal of balanced.signals) {
      expect(signal.unit).toBe("% flour")
      expect(signal.basis).toContain("Cake/batter prototype")
      expect(signal.basis).toContain("not a quality or nutrition judgment")
    }

    const outside = analyzeRecipe(
      [
        { id: "flour", name: "All-purpose flour", grams: 100 },
        { id: "water", name: "Water", grams: 200 },
        { id: "butter", name: "Butter", grams: 200 },
        { id: "sugar", name: "Sugar", grams: 200 },
        { id: "salt", name: "Salt", grams: 3 },
      ],
      "cake"
    )

    expect(outside.signals.map(({ status }) => status)).toEqual([
      "outside",
      "outside",
      "outside",
      "outside",
    ])
    expect(outside.signals.map(({ summary }) => summary)).toEqual([
      "Moisture above prototype band",
      "Fat above prototype band",
      "Sugar above prototype band",
      "Salt above prototype band",
    ])
  })

  it("returns unknown signals for unsupported recipe categories", () => {
    const analysis = analyzeRecipe(
      [
        { id: "flour", name: "All-purpose flour", grams: 100 },
        { id: "water", name: "Water", grams: 70 },
      ],
      "general"
    )

    expect(analysis.signals).toHaveLength(4)
    expect(analysis.signals.every(({ status }) => status === "unknown")).toBe(
      true
    )
    expect(analysis.signals[0]?.basis).toContain(
      "bread, dough, cake, and batter only"
    )
  })

  it("returns a zeroed analysis for an empty recipe", () => {
    const analysis = analyzeRecipe([], "bread")

    expect({
      totalMassG: analysis.totalMassG,
      knownMassG: analysis.knownMassG,
      coveragePercent: analysis.coveragePercent,
      waterG: analysis.waterG,
      waterPercent: analysis.waterPercent,
      dryMatterG: analysis.dryMatterG,
      dryMatterPercent: analysis.dryMatterPercent,
      flourMassG: analysis.flourMassG,
    }).toEqual({
      totalMassG: 0,
      knownMassG: 0,
      coveragePercent: 0,
      waterG: 0,
      waterPercent: 0,
      dryMatterG: 0,
      dryMatterPercent: 0,
      flourMassG: 0,
    })
    expect(analysis.per100g).toEqual({
      water: 0,
      dryMatter: 0,
      fat: 0,
      protein: 0,
      sugars: 0,
      starch: 0,
      fiber: 0,
      salt: 0,
      other: 0,
    })
    expect(analysis.solids).toHaveLength(7)
    expect(
      analysis.solids.every(
        ({ grams, percentOfDryMatter }) =>
          grams === 0 && percentOfDryMatter === 0
      )
    ).toBe(true)
    expect(analysis.matchedIngredients).toEqual([])
    expect(analysis.unknownIngredients).toEqual([])
    expect(analysis.signals.every(({ status }) => status === "unknown")).toBe(
      true
    )
    expect(analysis.signals[0]?.basis).toContain(
      "Add a mapped flour ingredient"
    )
  })
})

describe("recipe nutrition estimate", () => {
  it("derives energy from general conversion factors", () => {
    // 4/4/9 for protein/carbohydrate/fat, plus 2 kcal/g for fiber.
    expect(
      generalEnergyKcal({
        protein: 10,
        carbohydrate: 20,
        fat: 5,
        fiber: 3,
      })
    ).toBe(171)
  })

  it("keeps source values beside available carbohydrate and salt", () => {
    const analysis = analyzeRecipe([
      {
        id: "mapped",
        name: "Mapped formula",
        grams: 100,
        nutritionPer100g: {
          water: 12,
          fat: 29.847,
          protein: 4.932,
          sugars: 18.28,
          starch: 33.022,
          fiber: 1.209,
          salt: 0.629,
          other: 0,
          totalCarbohydrate: 52.51,
          sodiumMg: 251.7,
        },
      },
    ])
    const facts = recipeNutritionFacts(analysis)

    expect(facts.per100g.totalCarbohydrate).toBe(52.5)
    expect(facts.per100g.availableCarbohydrate).toBe(51.3)
    expect(facts.per100g.sodiumMg).toBe(251.7)
    expect(facts.per100g.salt).toBe(0.63)
    expect(facts.per100g.energyKcal).toBe(496)
    expect(facts.per100g.energyKj).toBe(2070)
  })

  it("derives new fields for nutrient snapshots saved before they existed", () => {
    const analysis = analyzeRecipe([
      {
        id: "mapped",
        name: "Mapped food",
        grams: 100,
        nutritionPer100g: {
          water: 50,
          fat: 10,
          protein: 10,
          sugars: 5,
          starch: 15,
          fiber: 5,
          salt: 1,
          other: 4,
        },
      },
    ])

    expect(analysis.nutritionTotals.totalCarbohydrate).toBe(25)
    expect(analysis.nutritionTotals.sodiumMg).toBe(400)
  })

  it("uses a declared finished weight for the per-100 g denominator", () => {
    const analysis = analyzeRecipe([
      { id: "sugar", name: "Granulated sugar", grams: 100 },
      { id: "water", name: "Water", grams: 100 },
    ])
    const raw = recipeNutritionFacts(analysis)
    const finished = recipeNutritionFacts(analysis, { finishedWeightG: 150 })

    expect(raw.per100g.totalCarbohydrate).toBe(50)
    expect(finished.per100g.totalCarbohydrate).toBe(66.7)
    expect(finished.basisWeightG).toBe(150)
    expect(finished.usesFinishedYield).toBe(true)
  })

  it("estimates per-100 g macros and energy for a mapped recipe", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([{ id: "sugar", name: "Granulated sugar", grams: 200 }])
    )

    expect(facts.hasData).toBe(true)
    expect(facts.coveragePercent).toBe(100)
    expect(facts.unknownCount).toBe(0)
    expect(facts.perPortion).toBeNull()
    expect(facts.per100g.totalCarbohydrate).toBe(100)
    expect(facts.per100g.availableCarbohydrate).toBe(100)
    expect(facts.per100g.sugars).toBe(100)
    // Pure sugar: 100 g carbohydrate per 100 g at 4 kcal/g.
    expect(facts.per100g.energyKcal).toBe(400)
  })

  it("divides the mapped batch evenly across a piece yield", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([{ id: "sugar", name: "Granulated sugar", grams: 200 }]),
      { portions: 4 }
    )

    expect(facts.portions).toBe(4)
    // Each of four portions carries a quarter of the 200 g of sugar.
    expect(facts.perPortion?.totalCarbohydrate).toBe(50)
    expect(facts.perPortion?.availableCarbohydrate).toBe(50)
    expect(facts.perPortion?.energyKcal).toBe(200)
    expect(facts.portionWeightG).toBe(50)
    // Per-100 g is unchanged by the yield.
    expect(facts.per100g.energyKcal).toBe(400)
  })

  it("reports coverage honestly and stays present with partial mapping", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([
        { id: "sugar", name: "Granulated sugar", grams: 100 },
        { id: "mystery", name: "Mystery powder", grams: 100 },
      ])
    )

    expect(facts.hasData).toBe(true)
    expect(facts.coveragePercent).toBe(50)
    expect(facts.unknownCount).toBe(1)
    // Known nutrients are divided by the whole batch, never inflated to make
    // the mapped half look like a complete 100 g food.
    expect(facts.per100g.energyKcal).toBe(200)
  })

  it("does not inflate a small mapped salt line across an unknown batch", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([
        { id: "water-dough", name: "Mooncake water dough", grams: 165 },
        { id: "oil-dough", name: "Mooncake oil dough", grams: 330 },
        { id: "scallions", name: "Scallions", grams: 600 },
        { id: "pork", name: "Ground pork", grams: 200 },
        { id: "pepper", name: "Black pepper", grams: 8 },
        { id: "salt", name: "Salt", grams: 10 },
      ]),
      { portions: 11 }
    )

    expect(facts.coveragePercent).toBeCloseTo(0.8, 1)
    expect(facts.coversWholeBatch).toBe(false)
    expect(facts.per100g.salt).toBe(0.76)
    expect(facts.perPortion?.salt).toBe(0.91)
  })

  it("uses a verified identity profile before the built-in seed profile", () => {
    const mapped = {
      water: 60,
      fat: 20,
      protein: 19,
      sugars: 0,
      starch: 0,
      fiber: 0,
      salt: 1,
      other: 0,
    }
    const analysis = analyzeRecipe([
      {
        id: "pork",
        name: "Ground pork",
        grams: 100,
        nutritionPer100g: mapped,
      },
    ])
    expect(analysis.coveragePercent).toBe(100)
    expect(analysis.nutritionTotals.protein).toBe(19)
    expect(recipeNutritionFacts(analysis).per100g.energyKcal).toBe(256)
  })

  it("has no estimate to show when nothing maps", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([{ id: "mystery", name: "Mystery powder", grams: 100 }]),
      { portions: 2 }
    )

    expect(facts.hasData).toBe(false)
    expect(facts.per100g.energyKcal).toBe(0)
    expect(facts.perPortion).toBeNull()
  })

  it("does not claim the whole batch when an ingredient line has no weight", () => {
    // "200 ml Mystery sauce" is ingredient-shaped but has no density mapping, so
    // the parser files it under unresolvedLines and it never reaches the
    // analyzed batch. Coverage over the weighed sugar alone is a full 100%, so
    // the panel must lean on the unweighed count — not the mass ratio — to stay
    // honest about the excluded sauce. A precise sub-100 mass percentage is not
    // computable for a weightless line, so coverage is qualified, not faked.
    const parsed = parseRecipeText(
      "100 g Granulated sugar\n200 ml Mystery sauce"
    )
    expect(parsed.ingredients).toHaveLength(1)
    expect(parsed.unresolvedLines).toHaveLength(1)

    const facts = recipeNutritionFacts(analyzeRecipe(parsed.ingredients), {
      unweighedIngredientCount: parsed.unresolvedLines.length,
    })

    expect(facts.hasData).toBe(true)
    expect(facts.coversWholeBatch).toBe(false)
    expect(facts.unweighedIngredientCount).toBe(1)
    expect(facts.unknownCount).toBe(1)
  })

  it("still claims whole-batch coverage when every line is weighed and mapped", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([{ id: "sugar", name: "Granulated sugar", grams: 200 }])
    )

    expect(facts.coversWholeBatch).toBe(true)
    expect(facts.coveragePercent).toBe(100)
    expect(facts.unweighedIngredientCount).toBe(0)
    expect(facts.unknownCount).toBe(0)
  })

  it("counts both unmapped weighed lines and unweighed lines as not-yet-mapped", () => {
    const facts = recipeNutritionFacts(
      analyzeRecipe([
        { id: "sugar", name: "Granulated sugar", grams: 100 },
        { id: "mystery", name: "Mystery powder", grams: 100 },
      ]),
      { unweighedIngredientCount: 1 }
    )

    expect(facts.coveragePercent).toBe(50)
    expect(facts.coversWholeBatch).toBe(false)
    expect(facts.unweighedIngredientCount).toBe(1)
    // One weighed-but-unmapped powder plus one unweighed line.
    expect(facts.unknownCount).toBe(2)
  })

  it("keys nutrition off the matched identity, matching the pricing path", () => {
    // A line named "Butter" repriced as "Olive Oil" via a match must be
    // analyzed as olive oil — the same identity the pricing path resolves — not
    // the built-in butter profile the raw text would otherwise select.
    const identities = [
      {
        id: "olive",
        name: "Olive Oil",
        normalizedName: "olive oil",
        source: "pantry" as const,
      },
    ]
    const matches = [
      {
        line: "Butter",
        targetId: "olive",
        targetName: "Olive Oil",
        measureName: "Olive Oil",
        targetKind: "ingredient" as const,
      },
    ]

    // The raw name and the aliased identity map to genuinely distinct profiles.
    expect(findIngredientProfile("Butter")?.key).toBe("unsalted-butter")
    expect(findIngredientProfile("Olive Oil")?.key).toBe("olive-oil")

    const resolved = resolveNutritionIngredient("Butter", identities, matches)
    expect(resolved).toEqual({
      name: "Olive Oil",
      isComponent: false,
      nutritionPer100g: null,
    })

    const analysis = analyzeRecipe([{ id: "l1", ...resolved, grams: 100 }])
    expect(analysis.matchedIngredients[0]?.profileKey).toBe("olive-oil")
    expect(analysis.coveragePercent).toBe(100)

    // Without the shared resolution, nutrition would have analyzed butter.
    const rawAnalysis = analyzeRecipe([
      { id: "l1", name: "Butter", grams: 100 },
    ])
    expect(rawAnalysis.matchedIngredients[0]?.profileKey).toBe(
      "unsalted-butter"
    )
  })

  it("keeps a renamed catalog ingredient's macros via the canonical measure name", () => {
    // Renaming a catalog-linked pantry entry keeps its canonical measureName,
    // which conversion and pricing already key off. Nutrition must follow the
    // same identity or the renamed line silently drops out of the estimate.
    const identities = [
      {
        id: "flour",
        name: "House Flour",
        normalizedName: "house flour",
        measureName: "Flour",
        source: "pantry" as const,
      },
    ]

    // The display name matches no profile; the canonical name does.
    expect(findIngredientProfile("House Flour")).toBeNull()
    expect(findIngredientProfile("Flour")?.key).toBe("all-purpose-flour")
    expect(findIngredientProfile("All-purpose flour")?.key).toBe(
      "all-purpose-flour"
    )

    const resolved = resolveNutritionIngredient("House Flour", identities)
    expect(resolved).toEqual({
      name: "Flour",
      isComponent: false,
      nutritionPer100g: null,
    })

    const analysis = analyzeRecipe([{ id: "l1", ...resolved, grams: 100 }])
    expect(analysis.matchedIngredients[0]?.profileKey).toBe("all-purpose-flour")
    expect(analysis.coveragePercent).toBe(100)
    expect(analysis.unknownIngredients).toHaveLength(0)

    // Without the canonical identity the line would have been unmapped.
    const rawAnalysis = analyzeRecipe([
      { id: "l1", name: "House Flour", grams: 100 },
    ])
    expect(rawAnalysis.coveragePercent).toBe(0)
  })

  it("keeps a component identity on its own title, not a measure name", () => {
    // A component is another recipe, so it has no catalog measure identity to
    // borrow — it must stay named after itself even if one is present.
    const identities = [
      {
        id: "dough",
        name: "House Flour",
        normalizedName: "house flour",
        measureName: "Flour",
        source: "component" as const,
      },
    ]

    expect(resolveNutritionIngredient("House Flour", identities)).toEqual({
      name: "House Flour",
      isComponent: true,
      nutritionPer100g: null,
    })
  })

  it("keeps a component distinct from a built-in profile of the same name", () => {
    // A component recipe titled "Honey" is a sub-recipe, not raw honey. Its
    // title collides with a built-in profile, so nutrition must carry the
    // component kind through or it would silently report honey's macros.
    const identities = [
      {
        id: "honey-glaze",
        name: "Honey",
        normalizedName: "honey",
        source: "component" as const,
      },
    ]

    expect(findIngredientProfile("Honey")?.key).toBe("honey")

    const resolved = resolveNutritionIngredient("Honey", identities)
    expect(resolved).toEqual({
      name: "Honey",
      isComponent: true,
      nutritionPer100g: null,
    })

    const analysis = analyzeRecipe([{ id: "l1", ...resolved, grams: 100 }])
    expect(analysis.matchedIngredients).toHaveLength(0)
    expect(analysis.unknownIngredients).toHaveLength(1)
    expect(analysis.coveragePercent).toBe(0)
    expect(analysis.per100g.sugars).toBe(0)

    const facts = recipeNutritionFacts(analysis)
    expect(facts.coversWholeBatch).toBe(false)
    expect(facts.unknownCount).toBe(1)
    expect(facts.hasData).toBe(false)

    // The same name as a plain ingredient line still reads the honey profile.
    const rawAnalysis = analyzeRecipe([{ id: "l1", name: "Honey", grams: 100 }])
    expect(rawAnalysis.matchedIngredients[0]?.profileKey).toBe("honey")
  })

  it("does not claim the whole batch when an unknown line rounds away", () => {
    // 1000 g mapped beside 0.4 g unmapped is 99.96% coverage, which rounds to
    // 100. Completeness must follow the unknown line, not the rounded figure.
    const facts = recipeNutritionFacts(
      analyzeRecipe([
        { id: "sugar", name: "Granulated sugar", grams: 1000 },
        { id: "mystery", name: "Mystery powder", grams: 0.4 },
      ])
    )

    expect(facts.coversWholeBatch).toBe(false)
    expect(facts.unknownCount).toBe(1)
    // The readout stays under 100 so it cannot read as complete coverage.
    expect(facts.coveragePercent).toBeLessThan(100)
    expect(facts.coveragePercent).toBe(99)
  })
})
