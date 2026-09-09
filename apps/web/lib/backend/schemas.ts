/**
 * Runtime shapes for the backend payloads that are cheap to describe in full.
 *
 * These are drift detectors, not parsers. Every object is a `strictObject` so
 * a key the backend adds or renames fails loudly in development instead of
 * arriving as `undefined` somewhere deep in a page. Validation never replaces
 * the payload — see `djangoGetParsed` in `./client` — so production and
 * development hand the same object to callers.
 *
 * Timestamp fields are `z.date()` because the client's reviver has already
 * turned those keys into `Date`. Date-only fields (`periodStart`, `periodEnd`,
 * `invoiceDate`, `effectiveFrom`, `currentRateEffectiveFrom`) are deliberately
 * outside that allowlist and stay `YYYY-MM-DD` strings; see docs/CONTRACT.md.
 */

import { z } from "zod"

import { submittedCustomNutritionValuesSchema } from "../nutrition/custom-values"
import { RECIPE_KINDS } from "../recipe/kinds"
import { RECIPE_STATUSES } from "../recipe/status"

const channelSchema = z.enum(["square", "shopify"])

/** Provider channels plus the first-party manual ledger source. */
const ledgerChannelSchema = z.enum(["square", "shopify", "manual"])

const trendComparisonSchema = z.enum([
  "prior_day",
  "prior_week",
  "prior_sunday",
  "four_weeks_prior",
  "fifty_two_weeks_prior",
  "prior_year",
])

/* -------------------------------------------------------------------------- */
/* session/                                                                    */
/* -------------------------------------------------------------------------- */

export const authMethodsSchema = z.strictObject({ google: z.boolean() })

export const sessionPayloadSchema = z.strictObject({
  user: z.strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    hasPassword: z.boolean(),
  }),
  // `status` stays a plain string: Stripe adds statuses, and this schema pins
  // the shape of the payload rather than its values.
  billing: z.strictObject({
    status: z.string(),
    trialDaysLeft: z.number().nullable(),
    locked: z.boolean(),
    plan: z.string(),
    entitlements: z.strictObject({
      maxRecipes: z.number().nullable(),
      primo: z.boolean(),
      posSync: z.boolean(),
      connectors: z.boolean(),
      usdaSearch: z.boolean(),
      catalogSearch: z.boolean(),
      invoiceAi: z.boolean(),
    }),
    // The owned-recipe count, on every plan.
    recipeCount: z.number(),
  }),
  // Kitchens this account belongs to, never the one it owns.
  kitchens: z.array(
    z.strictObject({
      id: z.string(),
      ownerId: z.string(),
      ownerName: z.string(),
      role: z.enum(["viewer", "editor"]),
    })
  ),
})

export type SessionPayload = z.infer<typeof sessionPayloadSchema>

/* -------------------------------------------------------------------------- */
/* newsletter/                                                                 */
/* -------------------------------------------------------------------------- */

/** `enabled` is null whenever Ghost cannot say what the state is. */
export const newsletterStatusSchema = z.strictObject({
  enabled: z.boolean().nullable(),
  available: z.boolean(),
})

/* -------------------------------------------------------------------------- */
/* ingredients/                                                                */
/* -------------------------------------------------------------------------- */

export const supplierItemSchema = z.strictObject({
  id: z.string(),
  supplier: z.string(),
  externalId: z.string(),
  title: z.string(),
  rawSize: z.string(),
  packPriceCents: z.number(),
  /** Grams in the pack, null when its unit carries no weight of its own. */
  packGrams: z.number().nullable(),
  packAmount: z.number(),
  packUnit: z.string(),
  purchasedQuantity: z.number().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  isPreferred: z.boolean(),
  updatedAt: z.date(),
})

const conversionMeasureSchema = z.strictObject({
  amount: z.number().nonnegative(),
  unit: z.string(),
})

const preparationMeasureSchema = z.strictObject({
  amount: z.number().positive(),
  unit: z.string().min(1),
})

/** A conversion is deliberately grouped by unit family on the wire. */
export const ingredientConversionSchema = z.strictObject({
  usesStandardConversion: z.boolean(),
  source: z.enum(["user", "catalog"]),
  confidence: z.enum(["high", "medium", "low"]),
  weight: conversionMeasureSchema.nullable(),
  volume: conversionMeasureSchema.nullable(),
  each: conversionMeasureSchema.nullable(),
  updatedAt: z.date(),
})

export const preparationSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  yieldPercent: z.number().positive().max(1000).nullable(),
  source: z.enum(["user", "catalog"]),
  confidence: z.enum(["high", "medium", "low"]),
  usesStandardConversion: z.boolean(),
  weight: preparationMeasureSchema.nullable(),
  volume: preparationMeasureSchema.nullable(),
  each: preparationMeasureSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const ingredientPriceSchema = z.strictObject({
  id: z.string(),
  purchaseCostCents: z.number(),
  purchaseSize: z.number().nullable(),
  purchaseUnit: z.string().nullable(),
  source: z.enum(["user", "master", "catalog", "supplier"]),
  effectiveAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const nutritionCompositionSchema = z.strictObject({
  water: z.number().nonnegative(),
  fat: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  sugars: z.number().nonnegative(),
  starch: z.number().nonnegative(),
  fiber: z.number().nonnegative(),
  salt: z.number().nonnegative(),
  other: z.number().nonnegative(),
  // Optional for nutrient snapshots saved before these source values were
  // preserved. The analysis layer derives compatible fallbacks for them.
  totalCarbohydrate: z.number().nonnegative().optional(),
  sodiumMg: z.number().nonnegative().optional(),
  // Null when the source record does not report saturates: unknown is not
  // zero, and a label preview says so.
  saturatedFat: z.number().nonnegative().nullable().optional(),
  calories: z.number().nonnegative().nullable(),
  transFat: z.number().nonnegative().nullable(),
  cholesterolMg: z.number().nonnegative().nullable(),
  addedSugars: z.number().nonnegative().nullable(),
  vitaminDMcg: z.number().nonnegative().nullable(),
  calciumMg: z.number().nonnegative().nullable(),
  ironMg: z.number().nonnegative().nullable(),
  potassiumMg: z.number().nonnegative().nullable(),
})

export const ingredientNutritionSchema = z.strictObject({
  source: z.enum(["usda_fdc", "custom"]),
  sourceId: z.string(),
  description: z.string(),
  per100g: nutritionCompositionSchema,
  updatedAt: z.date(),
  /** The package's own ingredient list, as a branded USDA record carries it.
   * Empty for a common food or a custom value. */
  packageIngredients: z.string(),
})

/**
 * Allergen tags the ingredient has not been told about yet: read off the
 * package text of its branded USDA record (`contains`, `mayContain`), or
 * flagged by the catalog as brand-dependent (`checkLabel`). A key the user
 * has already set or cleared never appears here.
 */
export const allergenHintsSchema = z.strictObject({
  contains: z.array(z.string()),
  mayContain: z.array(z.string()),
  checkLabel: z.array(z.string()),
})

export const ingredientTagSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
})
const ingredientAllergenSchema = z.strictObject({
  key: z.string(),
  status: z.enum(["contains", "mayContain", "doesNotContain"]),
  source: z.enum(["catalog", "user"]),
})

const ingredientInvoicePriceSchema = z.strictObject({
  id: z.string(),
  lineId: z.string(),
  supplier: z.string(),
  title: z.string(),
  externalId: z.string(),
  rawSize: z.string(),
  purchaseCostCents: z.number().int().nonnegative(),
  purchaseSize: z.number().positive().nullable(),
  purchaseUnit: z.string(),
  currencyCode: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string().nullable(),
  isUsedForCosting: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** The row used by the paginated pantry browse. Keep this cheap: detail-only
 * history, suppliers, and preparations are fetched after the user asks for
 * them. */
export const ingredientSummarySchema = z.strictObject({
  id: z.string(),
  /** Globally unique URL identifier (Stripe-style, e.g. "ing_k8f3m29qp7vw"). */
  publicId: z.string(),
  userId: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  measureName: z.string(),
  purchaseCostCents: z.number(),
  purchaseSize: z.number().nullable(),
  purchaseUnit: z.string().nullable(),
  priceSource: z.enum(["catalog", "master", "user"]),
  categoryId: z.string().nullable(),
  category: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  /** Not food (packaging, equipment): a supply, listed under /supplies. */
  nonEdible: z.boolean(),
  tags: z.array(ingredientTagSchema),
  effectiveAllergenKeys: z.array(z.string()),
  previousPrice: z
    .strictObject({
      purchaseCostCents: z.number(),
      purchaseSize: z.number().nullable(),
      purchaseUnit: z.string().nullable(),
      effectiveAt: z.date(),
    })
    .nullable(),
  preferredSupplier: z
    .strictObject({ id: z.string(), supplier: z.string(), title: z.string() })
    .nullable(),
  needsAttention: z.array(
    z.enum(["missingPrice", "missingPurchaseSize", "missingPurchaseUnit"])
  ),
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** Full ingredient record used by the detail route and lazy dialogs. */
export const ingredientSchema = z.strictObject({
  ...ingredientSummarySchema.shape,
  /** The counter the ingredient form sends back as its expectation. */
  editVersion: z.number(),
  /** The usable share after trim, (0, 100]. 100 means no loss. */
  yieldPercent: z.number(),
  /** One entry per recipe with a line naming this ingredient. `quantity` is
   * the sum when the recipe asks in a single unit, and the first line's
   * otherwise. */
  usedInRecipes: z.array(
    z.strictObject({
      id: z.string(),
      publicId: z.string(),
      title: z.string(),
      status: z.enum(["active", "archived"]),
      quantity: z.number().nullable(),
      unit: z.string(),
    })
  ),
  /** One entry per product whose components name this ingredient. A supply's
   * page reads its Used in from here: a recipe can never hold one. */
  usedInProducts: z.array(
    z.strictObject({
      id: z.string(),
      publicId: z.string(),
      name: z.string(),
      isActive: z.boolean(),
      quantity: z.number().nullable(),
      unit: z.string(),
    })
  ),
  nutrition: ingredientNutritionSchema.nullable(),
  /** Sugar, honey, syrups: every gram of its sugars is an added sugar. */
  sugarsAreAdded: z.boolean(),
  /** How the ingredient reads in a label's ingredient list; blank uses `name`. */
  nutritionLabelName: z.string(),
  nutritionRequest: z
    .strictObject({
      id: z.string(),
      status: z.enum(["pending", "applied", "dismissed", "superseded"]),
      servingGrams: z.number(),
      values: submittedCustomNutritionValuesSchema,
      source: z.string(),
      note: z.string(),
      createdAt: z.date(),
    })
    .nullable(),
  priceHistory: z.array(ingredientPriceSchema),
  supplierItems: z.array(supplierItemSchema),
  invoicePrices: z.array(ingredientInvoicePriceSchema),
  preparations: z.array(preparationSchema),
  conversion: ingredientConversionSchema.nullable(),
  effectiveAllergens: z.array(ingredientAllergenSchema),
  allergenHints: allergenHintsSchema,
})

export const paginationSchema = z.strictObject({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  pages: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  next: z.number().int().positive().nullable(),
  prev: z.number().int().positive().nullable(),
})

const pageMetaSchema = z.strictObject({ pagination: paginationSchema })

export const primoConversationSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  isArchived: z.boolean(),
  archivedAt: z.date().nullable(),
  lastMessageAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const primoConversationListSchema = z.strictObject({
  items: z.array(primoConversationSummarySchema),
  meta: pageMetaSchema,
})

export const primoConversationSchema = z.strictObject({
  item: z.strictObject({
    conversation: primoConversationSummarySchema,
    messages: z.array(
      z.strictObject({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.unknown()),
        status: z.enum(["complete", "aborted", "error"]),
        feedback: z.enum(["", "up", "down"]).optional(),
        feedbackComment: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()),
        createdAt: z.date(),
      })
    ),
  }),
})

export const ingredientPayloadSchema = z.strictObject({
  item: ingredientSchema.nullable(),
})

const categorySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
})

export const ingredientCategoriesPayloadSchema = z.strictObject({
  items: z.array(categorySchema),
})

export const recipeCategoriesPayloadSchema = z.strictObject({
  items: z.array(categorySchema),
})

/** A product's category is a string, not a row: the id is the name. */
export const productCategoriesPayloadSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.string(), label: z.string() })),
})

export const ingredientTagsPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      count: z.number().int().nonnegative(),
    })
  ),
})

const ingredientFacetCountSchema = z.strictObject({
  key: z.string(),
  count: z.number().int().nonnegative(),
})

const ingredientNamedFacetSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
})

const ingredientFacetsSchema = z.strictObject({
  attention: z.array(ingredientFacetCountSchema),
  category: z.array(ingredientNamedFacetSchema),
  tags: z.array(ingredientNamedFacetSchema),
  allergens: z.array(ingredientFacetCountSchema),
})

export const ingredientsPayloadSchema = z.strictObject({
  items: z.array(ingredientSummarySchema),
  meta: pageMetaSchema,
  hasAnyIngredient: z.boolean(),
  queryCount: z.number().int().nonnegative(),
  facets: ingredientFacetsSchema,
})

export const catalogIngredientSuggestionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  preparations: z.array(z.string()),
  /** The card's synonyms, so a pasted spelling can link itself. */
  aliases: z.array(z.string()),
})

export type CatalogIngredientSuggestion = z.infer<
  typeof catalogIngredientSuggestionSchema
>

export const catalogIngredientsPayloadSchema = z.strictObject({
  items: z.array(catalogIngredientSuggestionSchema),
})

/** Materializing a catalog card reports the pantry row the picker must show. */
export const catalogActivationSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  created: z.boolean(),
  seededMeasures: z.number(),
  seededPreparations: z.number(),
  preparations: z.array(z.string()),
})

/* -------------------------------------------------------------------------- */
/* recipes/                                                                    */
/* -------------------------------------------------------------------------- */

/** The list view includes the viewer's role and lifecycle capabilities. */
export const recipeSummarySchema = z.strictObject({
  id: z.string(),
  /** Globally unique URL identifier (Stripe-style, e.g. "rcp_k8f3m29qp7vw"). */
  publicId: z.string(),
  title: z.string(),
  /** Internal per-user sequential code; not shown in UI or URLs. */
  code: z.string(),
  kind: z.enum(RECIPE_KINDS),
  status: z.enum(RECIPE_STATUSES),
  /** Held against stray edits while someone cooks from it. */
  locked: z.boolean(),
  categoryId: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().optional(),
  /** Ingredient lines the parser costs. */
  body: z.string(),
  /** Preparation steps as free text. Blank means no method has been added. */
  method: z.string(),
  yieldAmount: z.number().nullable(),
  yieldUnit: z.string().nullable(),
  servingAmount: z.number().nullable().optional(),
  servingUnit: z.string().optional(),
  /** The serving a label preview describes; separate from the cost serving. */
  nutritionServingAmount: z.number().nullable().optional(),
  nutritionServingUnit: z.string().optional(),
  /** The retail package; unset means one batch is one container. */
  nutritionPackageAmount: z.number().nullable().optional(),
  nutritionPackageUnit: z.string().optional(),
  shelfLifeAmount: z.number().nullable().optional(),
  shelfLifeUnit: z.string().optional(),
  /** The recipe's labor time, unless autoPrepTimeEnabled sums the steps. */
  prepTimeAmount: z.number().nullable().optional(),
  prepTimeUnit: z.string().optional(),
  autoSumYieldEnabled: z.boolean().optional(),
  autoPrepTimeEnabled: z.boolean().optional(),
  percentageMode: z.string().optional(),
  percentIngredientEnabled: z.boolean().optional(),
  percentIngredientType: z.string().optional(),
  ownerId: z.string().optional(),
  ownerName: z.string().optional(),
  permission: z.enum(["owner", "editor", "viewer"]).optional(),
  canEdit: z.boolean().optional(),
  canDelete: z.boolean().optional(),
  canViewCost: z.boolean().optional(),
  menuPriceCents: z.number().nullable(),
  updatedAt: z.date(),
})

const recipeItemSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["header", "note", "ingredient", "subrecipe"]),
  position: z.number().int().nonnegative(),
  displayName: z.string(),
  quantity: z.number().nullable(),
  unit: z.string(),
  preparationNote: z.string(),
  efficiency: z.number(),
  efficiencyAfterCooking: z.number(),
  isBase: z.boolean(),
  excludedFromCost: z.boolean(),
  ingredientId: z.string().nullable(),
  subrecipeId: z.string().nullable(),
  ingredientName: z.string().nullable(),
  subrecipeName: z.string().nullable(),
  /** This saved row's contribution to one batch, owner-only. */
  costCents: z.number().nullable(),
  resolved: z.boolean(),
  // The linked recipe one level deep, so a sub-recipe line can open in place.
  // Absent on a line linked in this session and not yet saved.
  subrecipe: z
    .strictObject({
      id: z.string(),
      publicId: z.string(),
      title: z.string(),
      yieldAmount: z.number().nullable(),
      yieldUnit: z.string().nullable(),
      items: z.array(
        z.strictObject({
          kind: z.enum(["header", "note", "ingredient", "subrecipe"]),
          quantity: z.number().nullable(),
          unit: z.string(),
          displayName: z.string(),
          preparationNote: z.string(),
          subrecipeId: z.string().nullable(),
          excludedFromCost: z.boolean(),
        })
      ),
    })
    .nullable()
    .optional(),
})

const recipeTimingSchema = z.strictObject({
  id: z.string(),
  stepId: z.string(),
  seconds: z.number().int().positive(),
  yieldCount: z.number().int().positive(),
  createdAt: z.date(),
})

const recipeStepSchema = z.strictObject({
  id: z.string(),
  recipeId: z.string(),
  kind: z.enum(["instruction", "header", "note"]),
  title: z.string(),
  body: z.string(),
  position: z.number().int().nonnegative(),
  laborKind: z.enum(["", "active", "passive"]),
  timings: z.array(recipeTimingSchema),
  media: z
    .array(
      z.strictObject({
        id: z.string(),
        recipeId: z.string().nullable(),
        stepId: z.string().nullable(),
        url: z.string(),
        thumbnailUrl: z.string(),
        mobileUrl: z.string(),
        altText: z.string(),
        position: z.number().int().nonnegative(),
      })
    )
    .optional(),
})

const recipeBatchSizeSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  scale: z.number().positive(),
  isOriginal: z.boolean(),
})

const recipeEquivalencySchema = z.strictObject({
  id: z.string(),
  massAmount: z.number().nullable(),
  massUnit: z.string(),
  volumeAmount: z.number().nullable(),
  volumeUnit: z.string(),
  countAmount: z.number().nullable(),
  countUnit: z.string(),
  standard: z.boolean(),
})

const recipeTagSchema = z.strictObject({ id: z.string(), name: z.string() })
const recipeCommentSchema = z.strictObject({
  id: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
const recipeMediaSchema = z.strictObject({
  id: z.string(),
  recipeId: z.string().nullable(),
  stepId: z.string().nullable(),
  url: z.string(),
  thumbnailUrl: z.string(),
  mobileUrl: z.string(),
  altText: z.string(),
  position: z.number().int().nonnegative(),
})
const recipeShareSchema = z.strictObject({
  id: z.string(),
  recipientId: z.string(),
  recipientName: z.string(),
  role: z.enum(["viewer", "editor"]),
})
const recipeGuestLinkSchema = z.strictObject({
  id: z.string(),
  email: z.string(),
  role: z.enum(["viewer", "editor"]),
  createdAt: z.date(),
})

/** A book link, listed on every recipe inside it so any can revoke it. */
const recipeBookLinkSchema = z.strictObject({
  id: z.string(),
  email: z.string(),
  role: z.enum(["viewer", "editor"]),
  title: z.string(),
  recipeCount: z.number(),
  createdAt: z.date(),
})

export const recipeDetailSchema = z.strictObject({
  ...recipeSummarySchema.shape,
  userId: z.string(),
  /** The optimistic-concurrency counter a save sends back as its expectation. */
  editVersion: z.number(),
  createdAt: z.date(),
  externalRefs: z.array(
    z.strictObject({
      id: z.string(),
      system: z.string(),
      refKind: z.string(),
      externalId: z.string(),
    })
  ),
  items: z.array(recipeItemSchema),
  steps: z.array(recipeStepSchema),
  batchSizes: z.array(recipeBatchSizeSchema),
  equivalency: recipeEquivalencySchema.nullable(),
  tags: z.array(recipeTagSchema),
  comments: z.array(recipeCommentSchema),
  media: z.array(recipeMediaSchema),
  shares: z.array(recipeShareSchema),
  guestLinks: z.array(recipeGuestLinkSchema),
  bookLinks: z.array(recipeBookLinkSchema),
  ingredientOptions: z.array(
    z.strictObject({ id: z.string(), name: z.string() })
  ),
  recipeOptions: z.array(
    z.strictObject({ id: z.string(), publicId: z.string(), title: z.string() })
  ),
  // The parent recipes that link this one as a sub-recipe.
  usedIn: z.array(
    z.strictObject({
      id: z.string(),
      publicId: z.string(),
      title: z.string(),
      status: z.enum(["active", "archived"]),
      quantity: z.number().nullable(),
      unit: z.string(),
    })
  ),
  ingredientCostCents: z.number().nullable(),
  foodCost: z.number().nullable(),
  attention: z.array(z.string()),
})

export const recipePayloadSchema = z.strictObject({
  item: recipeDetailSchema.nullable(),
})

const recipeCostDiffSideSchema = z.strictObject({
  status: z.enum(["priced", "noHistory", "unpriceable"]),
  costCents: z.number().nullable(),
  unitCostCents: z.number().nullable(),
  effectiveAt: z.string().nullable(),
  source: z.string().nullable(),
  supplier: z.string().nullable(),
})

const recipeCostDiffLineSchema = z.strictObject({
  itemId: z.string(),
  kind: z.enum(["ingredient", "subrecipe"]),
  name: z.string(),
  ingredientPublicId: z.string().nullable(),
  status: z.enum(["comparable", "excluded", "missingQuantity", "unresolved"]),
  basis: z.strictObject({
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    efficiency: z.number(),
    preparation: z.string().nullable(),
  }),
  from: recipeCostDiffSideSchema.nullable(),
  to: recipeCostDiffSideSchema.nullable(),
  deltaCents: z.number().nullable(),
})

export const recipeCostDiffPayloadSchema = z.strictObject({
  item: z.strictObject({
    recipe: z.strictObject({
      id: z.string(),
      publicId: z.string(),
      title: z.string(),
    }),
    window: z.strictObject({
      fromAt: z.string(),
      toAt: z.string(),
      fromDate: z.string(),
      toDate: z.string(),
      days: z.number().int().nonnegative(),
      source: z.enum(["default90Days", "requestedDate"]),
      comparison: z.literal("priceOnlyCurrentRecipeBasis"),
    }),
    basis: z.string(),
    totals: z.strictObject({
      fromCents: z.number().nullable(),
      toCents: z.number().nullable(),
      deltaCents: z.number().nullable(),
      fromComplete: z.boolean(),
      toComplete: z.boolean(),
      comparableFromCents: z.number(),
      comparableToCents: z.number(),
      comparableDeltaCents: z.number(),
    }),
    coverage: z.strictObject({
      requiredLines: z.number().int().nonnegative(),
      comparableBoth: z.number().int().nonnegative(),
      skippedLines: z.number().int().nonnegative(),
    }),
    priceChangesInWindow: z.number().int().nonnegative(),
    lastChangeBeforeWindow: z
      .strictObject({
        at: z.string(),
        ingredient: z.strictObject({
          publicId: z.string(),
          name: z.string(),
        }),
      })
      .nullable(),
    lines: z.array(recipeCostDiffLineSchema),
    issues: z.array(z.string()),
    currencyCode: z.string(),
  }),
})

/* -------------------------------------------------------------------------- */
/* guest/recipes/<token>/                                                      */
/* -------------------------------------------------------------------------- */

/** The read-only shape a guest link serves: no ids, no costs, no ownership. */
const guestRecipeLineSchema = z.strictObject({
  kind: z.enum(["header", "note", "ingredient", "subrecipe"]),
  displayName: z.string(),
  quantity: z.number().nullable(),
  unit: z.string(),
  preparationNote: z.string(),
})

// Named rather than inline so the envelope parity parser can walk into it.
const guestSubrecipeSchema = z.strictObject({
  title: z.string(),
  yieldAmount: z.number().nullable(),
  yieldUnit: z.string().nullable(),
  items: z.array(guestRecipeLineSchema),
})

const guestRecipeItemSchema = z.strictObject({
  ...guestRecipeLineSchema.shape,
  subrecipe: guestSubrecipeSchema.nullable(),
})

/** A guest sees the batch labels, never the ids behind them. */
const guestBatchSizeSchema = z.strictObject({
  label: z.string(),
  scale: z.number().positive(),
  isOriginal: z.boolean(),
})

const guestRecipeStepSchema = z.strictObject({
  kind: z.enum(["instruction", "header", "note"]),
  title: z.string(),
  body: z.string(),
})

const guestRecipeSchema = z.strictObject({
  role: z.enum(["viewer", "editor"]),
  title: z.string(),
  description: z.string(),
  yieldAmount: z.number().nullable(),
  yieldUnit: z.string().nullable(),
  servingAmount: z.number().nullable(),
  servingUnit: z.string(),
  batchSizes: z.array(guestBatchSizeSchema),
  items: z.array(guestRecipeItemSchema),
  steps: z.array(guestRecipeStepSchema),
  ownerName: z.string(),
})

export const guestRecipePayloadSchema = z.strictObject({
  item: guestRecipeSchema,
})

/* -------------------------------------------------------------------------- */
/* guest/books/<token>/                                                        */
/* -------------------------------------------------------------------------- */

/** Several recipes behind one token, in the order they were shared. */
const guestBookSchema = z.strictObject({
  title: z.string(),
  ownerName: z.string(),
  role: z.enum(["viewer", "editor"]),
  recipes: z.array(guestRecipeSchema),
})

export const guestBookPayloadSchema = z.strictObject({
  item: guestBookSchema,
})

/* -------------------------------------------------------------------------- */
/* recipes/<ref>/nutrition/                                                    */
/* -------------------------------------------------------------------------- */

export const NUTRIENT_KEYS = [
  "calories",
  "energyKj",
  "fat",
  "saturatedFat",
  "transFat",
  "cholesterolMg",
  "sodiumMg",
  "salt",
  "totalCarbohydrate",
  "fiber",
  "sugars",
  "addedSugars",
  "protein",
  "vitaminDMcg",
  "calciumMg",
  "ironMg",
  "potassiumMg",
] as const

export type NutrientKey = (typeof NUTRIENT_KEYS)[number]

/** A summed nutrient. `complete` is false when a linked record did not report
 * it, so the amount is the sum of what is known, never a claimed zero. */
const nutrientValueSchema = z.strictObject({
  amount: z.number().nonnegative(),
  complete: z.boolean(),
})

// Spelled out key by key: the contract test reads this file as text.
export const nutrientsSchema = z.strictObject({
  calories: nutrientValueSchema,
  energyKj: nutrientValueSchema,
  fat: nutrientValueSchema,
  saturatedFat: nutrientValueSchema,
  transFat: nutrientValueSchema,
  cholesterolMg: nutrientValueSchema,
  sodiumMg: nutrientValueSchema,
  salt: nutrientValueSchema,
  totalCarbohydrate: nutrientValueSchema,
  fiber: nutrientValueSchema,
  sugars: nutrientValueSchema,
  addedSugars: nutrientValueSchema,
  protein: nutrientValueSchema,
  vitaminDMcg: nutrientValueSchema,
  calciumMg: nutrientValueSchema,
  ironMg: nutrientValueSchema,
  potassiumMg: nutrientValueSchema,
})

export const RECIPE_NUTRITION_BATCH_ISSUES = [
  "unlinkedIngredient",
  "unweighedItem",
  "unresolvedItem",
  "subrecipeIncomplete",
  "subrecipeUnresolved",
  "subrecipeEmpty",
  "allExcluded",
  "noYield",
] as const

export const RECIPE_NUTRITION_SERVING_ISSUES = [
  "noServingSize",
  "servingNeedsEquivalency",
  "packageNeedsEquivalency",
  "packageBelowServing",
  "servingAboveBatch",
  "packageAboveBatch",
] as const

export const recipeNutritionLineSchema = z.strictObject({
  itemId: z.string(),
  kind: z.enum(["ingredient", "subrecipe"]),
  name: z.string(),
  /** The line's ingredient has allergen hints nobody has confirmed or
   * dismissed. Always false for a viewer. */
  hasAllergenHints: z.boolean(),
  /** Null for a viewer, who cannot open the owner's pantry. */
  ingredientPublicId: z.string().nullable(),
  /** Null for a viewer who cannot open that recipe. */
  subrecipePublicId: z.string().nullable(),
  /** The linked record's description; null when unlinked or for a viewer. */
  linkedDescription: z.string().nullable(),
  linkedSource: z.enum(["usda_fdc", "custom"]).nullable(),
  nonEdible: z.boolean(),
  /** Yield after cooking, 0..100. */
  efficiencyAfterCooking: z.number(),
  /** The line as written, in grams; null when nothing relates them. */
  grams: z.number().nullable(),
  /** Grams that stay in the dish: `grams` times the yield after cooking. */
  netGrams: z.number().nullable(),
  status: z.enum([
    "linked",
    "unlinked",
    "nonEdible",
    "discarded",
    "unresolved",
    "unweighed",
    "subrecipeIncomplete",
  ]),
})

const nutritionReadinessSchema = z.strictObject({
  ready: z.boolean(),
  /** Mandatory nutrients for this format that no linked record reports. */
  missing: z.array(z.enum(NUTRIENT_KEYS)),
})

export const recipeNutritionSchema = z.strictObject({
  recipeId: z.string(),
  publicId: z.string(),
  title: z.string(),
  permission: z.enum(["owner", "editor", "viewer"]),
  canEdit: z.boolean(),
  serving: z.strictObject({
    amount: z.number().nullable(),
    unit: z.string(),
    /** The serving in grams, once the yield or equivalency relates them. */
    grams: z.number().nullable(),
  }),
  /** The retail package; unset means one batch is one container. */
  package: z.strictObject({
    amount: z.number().nullable(),
    unit: z.string(),
    grams: z.number().nullable(),
  }),
  batch: z.strictObject({
    /** Declared finished weight when stated, else the net input sum. */
    grams: z.number().nullable(),
    declaredGrams: z.number().nullable(),
    inputGrams: z.number(),
    /** Servings in one container, when the serving is known. */
    servings: z.number().nullable(),
    /** Containers the batch fills, when a package is set. */
    containers: z.number().nullable(),
  }),
  lines: z.array(recipeNutritionLineSchema),
  totals: z.strictObject({
    /** Null while a batch issue stands. */
    batch: nutrientsSchema.nullable(),
    per100g: nutrientsSchema.nullable(),
    /** Null while a batch or serving issue stands. */
    perServing: nutrientsSchema.nullable(),
  }),
  allergens: z.strictObject({
    contains: z.array(z.string()),
    mayContain: z.array(z.string()),
  }),
  /** Ingredient statement entries, heaviest first, nested recipes expanded.
   * `allergens` are the tags the entry's ingredient carries as "contains", so
   * a label can emphasise the entry and name the species under its group. */
  statement: z.array(
    z.strictObject({
      name: z.string(),
      grams: z.number(),
      allergens: z.array(z.string()),
    })
  ),
  issues: z.strictObject({
    batch: z.array(z.enum(RECIPE_NUTRITION_BATCH_ISSUES)),
    serving: z.array(z.enum(RECIPE_NUTRITION_SERVING_ISSUES)),
  }),
  readiness: z.strictObject({
    us: nutritionReadinessSchema,
    eu: nutritionReadinessSchema,
  }),
})

export const recipeNutritionPayloadSchema = z.strictObject({
  item: recipeNutritionSchema.nullable(),
})

const recipeFacetCountSchema = z.strictObject({
  key: z.string(),
  count: z.number().int().nonnegative(),
})

const recipeNamedFacetSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
})

const recipeFacetsSchema = z.strictObject({
  status: z.array(recipeFacetCountSchema),
  attention: z.array(recipeFacetCountSchema),
  category: z.array(recipeNamedFacetSchema),
  tags: z.array(recipeNamedFacetSchema),
  ingredients: z.array(recipeNamedFacetSchema),
  allergens: z.array(recipeFacetCountSchema),
  ownership: z.array(recipeFacetCountSchema),
})

export type RecipeFacets = z.infer<typeof recipeFacetsSchema>

export const recipesPayloadSchema = z.strictObject({
  items: z.array(recipeSummarySchema),
  meta: pageMetaSchema,
  hasAnyRecipe: z.boolean(),
  queryCount: z.number().int().nonnegative(),
  facets: recipeFacetsSchema,
})

/* -------------------------------------------------------------------------- */
/* pricing-entries/                                                            */
/* -------------------------------------------------------------------------- */

export const pricingEntriesPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      normalizedName: z.string(),
      measureName: z.string(),
      /** Archived entries stay in this read so linked lines keep costing; the
       * picker skips them. Supplies stay for the same reason. */
      status: z.enum(["active", "archived"]),
      nonEdible: z.boolean(),
      purchaseCostCents: z.number(),
      purchaseSize: z.number().nullable(),
      purchaseUnit: z.string().nullable(),
      yieldPercent: z.number(),
      conversion: ingredientConversionSchema.nullable(),
      preparations: z.array(preparationSchema),
      nutritionPer100g: nutritionCompositionSchema.nullable(),
    })
  ),
  recipes: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      kind: z.enum(RECIPE_KINDS),
      yieldAmount: z.number().nullable(),
      yieldUnit: z.string().nullable(),
      equivalency: recipeEquivalencySchema.nullable(),
      category: z.string().nullable(),
    })
  ),
})

export const searchIndexPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      label: z.string(),
      href: z.string(),
      type: z.enum(["recipe", "ingredient"]),
    })
  ),
})

/* -------------------------------------------------------------------------- */
/* pos-connections/ and pos-sync-runs/                                         */
/* -------------------------------------------------------------------------- */

export const posConnectionSchema = z.strictObject({
  provider: channelSchema,
  providerAccountId: z.string(),
  generation: z.number().int().positive(),
  status: z.enum(["active", "needs_reconnect", "disconnecting"]),
  merchantId: z.string(),
  shopDomain: z.string(),
  scopes: z.string(),
  providerTimezone: z.string(),
  currencyCode: z.string(),
  lastSyncedAt: z.string().nullable(),
  backfilledAt: z.string().nullable(),
  lastError: z.string(),
  connectedAt: z.string(),
})

export const posConnectionsPayloadSchema = z.strictObject({
  items: z.array(posConnectionSchema),
})

export const posSyncReceiptSchema = z.strictObject({
  provider: channelSchema,
  batchId: z.string().nullable(),
  batchIds: z.array(z.string()).optional(),
  imported: z.number(),
  updated: z.number(),
  deduplicated: z.number(),
  trackedLines: z.number(),
  pendingLines: z.number(),
  ignoredLines: z.number(),
  pendingIdentities: z.number(),
  ignoredIdentities: z.number(),
  skippedMalformed: z.number(),
  modifierOccurrences: z.number(),
  modifierOccurrencesAttached: z.number(),
  modifierOccurrencesPending: z.number(),
  pendingModifierIdentities: z.number(),
  skippedModifiersMalformed: z.number(),
  skippedUnmatched: z.number(),
  skippedIgnored: z.number(),
  warnings: z.number(),
  partial: z.boolean(),
  pagesProcessed: z.number(),
  linesFetched: z.number(),
  categoriesBackfilled: z.number(),
  catalogItemCount: z.number(),
  ruleIgnoredIdentities: z.number().optional(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
})

export const posSyncRunSchema = z.strictObject({
  id: z.string(),
  provider: channelSchema,
  providerAccountId: z.string(),
  connectionGeneration: z.number().int().positive(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.strictObject({
    phase: z.string().optional(),
    continuationPasses: z.number().optional(),
    partial: z.boolean().optional(),
    pagesProcessed: z.number().optional(),
    linesFetched: z.number().optional(),
    imported: z.number().optional(),
    updated: z.number().optional(),
    deduplicated: z.number().optional(),
    lastPassAt: z.string().optional(),
  }),
  cursor: z.strictObject({
    watermark: z.string().nullable(),
    continuationPasses: z.number(),
  }),
  result: z.strictObject({
    receipt: posSyncReceiptSchema.partial().optional(),
  }),
  error: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  queuedAt: z.string(),
  availableAt: z.string(),
  startedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const posSyncRunsPayloadSchema = z.strictObject({
  items: z.array(posSyncRunSchema),
})

export const posSyncRunPayloadSchema = z.strictObject({
  syncRun: posSyncRunSchema,
})

/* -------------------------------------------------------------------------- */
/* sales-overview/                                                             */
/* -------------------------------------------------------------------------- */

const trendSeriesPointSchema = z.strictObject({
  currentSquareCents: z.number(),
  currentShopifyCents: z.number(),
  currentManualCents: z.number(),
  previousSquareCents: z.number(),
  previousShopifyCents: z.number(),
  previousManualCents: z.number(),
})

export const netSalesTrendSchema = z.strictObject({
  /** The latest local sales date, or null when there are no tracked sales. */
  currentDate: z.string().nullable(),
  /** The selected comparison date, retained for compatibility with prior data. */
  previousDate: z.string().nullable(),
  /** The selected comparison date, or null when there are no tracked sales. */
  comparisonDate: z.string().nullable(),
  /** Inclusive start and end dates for the selected period. */
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** Inclusive start and end dates for the comparison period. */
  comparisonStart: z.string().nullable(),
  comparisonEnd: z.string().nullable(),
  granularity: z.enum(["hour", "day"]),
  comparison: trendComparisonSchema,
  /** Recent local sales dates that can be selected in the Home chart. */
  availableDates: z.array(z.string()),
  timezone: z.string(),
  /** The workspace currency every figure below is denominated in. */
  currencyCode: z.string(),
  financials: z.strictObject({
    currentLaborCents: z.number(),
    previousLaborCents: z.number(),
    currentInvoiceCents: z.number(),
    previousInvoiceCents: z.number(),
    currentInvoiceCount: z.number(),
    previousInvoiceCount: z.number(),
  }),
  hours: z.array(
    z.strictObject({ hour: z.number(), ...trendSeriesPointSchema.shape })
  ),
  days: z.array(
    z.strictObject({ date: z.string(), ...trendSeriesPointSchema.shape })
  ),
})

export const dailySalesSchema = z.strictObject({
  id: z.string(),
  channel: ledgerChannelSchema,
  soldOn: z.string(),
  productId: z.string(),
  productName: z.string(),
  sku: z.string(),
  itemName: z.string(),
  quantity: z.number(),
  grossCents: z.number(),
  discountCents: z.number(),
  /** Null means a manual count was recorded without a total. */
  netSalesCents: z.number().nullable(),
  taxCents: z.number(),
  refundCents: z.number(),
  currencyCode: z.string(),
})

export const periodProductSalesSchema = z.strictObject({
  productId: z.string(),
  productName: z.string(),
  channel: ledgerChannelSchema,
  quantity: z.number(),
  netSalesCents: z.number().nullable(),
  /** A bundle in the including-bundles view: its money sits on its members,
   * so this row carries units and zero. Defaulted for deploy order. */
  sharedToMembers: z.boolean().default(false),
})

export const salesImportSchema = z.strictObject({
  id: z.string(),
  fileName: z.string(),
  channel: channelSchema,
  providerAccountId: z.string(),
  source: z.enum(["csv", "api"]),
  timezone: z.string(),
  currencyCode: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  totalRows: z.number(),
  importedCount: z.number(),
  duplicateCount: z.number(),
  skippedCount: z.number(),
  ignoredCount: z.number(),
  orderCount: z.number(),
  grossCents: z.number(),
  discountCents: z.number(),
  netSalesCents: z.number(),
  taxCents: z.number(),
  refundCents: z.number(),
  createdAt: z.date(),
  undoneAt: z.date().nullable(),
  canUndo: z.boolean(),
})

/* -------------------------------------------------------------------------- */
/* menu-items/                                                                 */
/* -------------------------------------------------------------------------- */

export const salesProductVariantSchema = z.strictObject({
  id: z.string(),
  channel: channelSchema,
  providerAccountId: z.string(),
  matchKey: z.string(),
  sku: z.string(),
  externalName: z.string(),
  externalVariantTitle: z.string(),
  identityKind: z.enum(["item", "modifier"]),
  /** Provider catalog id — immutable once saved, blank for SKU/name keys. */
  externalObjectId: z.string(),
  /** Shopify Product gid fallback; exact variant title remains separate. */
  productExternalObjectId: z.string(),
  /** Units of this menu item consumed per one external identity. */
  quantityMultiplier: z.number(),
  /** Whole percent of the sale owned by these products; null reads as 100. */
  attributionPercent: z.number().nullable(),
})

const productSalesStatsSchema = z.strictObject({
  /** Financial lines sold directly as this product. */
  lineCount: z.number(),
  quantity: z.number(),
  totalQuantity: z.number(),
  grossCents: z.number(),
  discountCents: z.number(),
  /** Authoritative POS net sales recorded directly against this product. */
  netSalesCents: z.number(),
  attributedNetSalesCents: z.number(),
  taxCents: z.number(),
  refundCents: z.number(),
  /** This row is a bundle in the including-bundles view: its money moved to
   * the products inside it, so every money field above reads zero. */
  sharedToMembers: z.boolean().default(false),
  /** What the bundle itself sold for, before that move. */
  asSoldNetSalesCents: z.number().default(0),
  /** Which rung of the allocation ladder split this bundle. Null off a
   * bundle. Defaults let Next and Django deploy in either order. */
  splitBasis: z.enum(["price", "cost", "count"]).nullable().default(null),
})

/** One editable Product composition row. Exactly one target is populated. */
export const productComponentSchema = z.strictObject({
  id: z.string(),
  recipeId: z.string().nullable(),
  recipePublicId: z.string().nullable(),
  recipeName: z.string().nullable(),
  ingredientId: z.string().nullable(),
  ingredientPublicId: z.string().nullable(),
  ingredientName: z.string().nullable(),
  /** Set when this component is another product — a bundle member. */
  productId: z.string().nullable(),
  productPublicId: z.string().nullable(),
  productName: z.string().nullable(),
  quantity: z.number().positive(),
  unit: z.string(),
  position: z.number().int().nonnegative(),
  nonEdible: z.boolean(),
})

/** One SKU that sells the product, and how many units one sale is. */
export const productSkuSchema = z.strictObject({
  id: z.string(),
  sku: z.string(),
  quantityMultiplier: z.number(),
  position: z.number().int().nonnegative(),
})

export const salesProductSchema = z.strictObject({
  id: z.string(),
  /** Stable opaque URL identity; distinct from the internal UUID. */
  publicId: z.string(),
  /** Optimistic-concurrency counter sent with product edits. */
  editVersion: z.number().int().nonnegative(),
  name: z.string(),
  normalizedName: z.string(),
  sku: z.string(),
  skus: z.array(productSkuSchema),
  description: z.string(),
  sellPriceCents: z.number().int().nonnegative(),
  /**
   * What one sold unit of this product is. Blank reads as "each" — the unit
   * every product carried before the column existed.
   */
  baseUnit: z.string(),
  category: z.string(),
  isActive: z.boolean(),
  costed: z.boolean(),
  components: z.array(productComponentSchema),
  recipeLinks: z.array(
    z.strictObject({
      recipeId: z.string(),
      publicId: z.string(),
      recipeTitle: z.string(),
      quantity: z.number(),
    })
  ),
  variants: z.array(salesProductVariantSchema),
  sales: productSalesStatsSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** Product detail extends the summary with its channel/day ledger rows. */
export const productDetailSalesSchema = z.strictObject({
  ...productSalesStatsSchema.shape,
  dailySales: z.array(dailySalesSchema),
  manualSales: z.array(
    z.strictObject({
      id: z.string(),
      soldOn: z.string(),
      quantity: z.number(),
      totalNetCents: z.number().nullable(),
    })
  ),
})

/**
 * One reason a physical value could not be resolved. `path` names the trail
 * that reached it — recipe, then ingredient — so the reader can say which row
 * to fix rather than only that something is missing.
 */
export const expansionIssueSchema = z.strictObject({
  code: z.string(),
  path: z.array(z.string()),
  detail: z.string().nullable(),
})

/** One Products Hub product, returned by `product/<product_ref>/`. */
export const productDetailSchema = z.strictObject({
  ...salesProductSchema.shape,
  /** Including bundles — what a product-centric surface shows. */
  sales: productDetailSalesSchema,
  /** The figures attached to this product's own variants. Optional only until
   * the backend emitting it lands; a missing one reads as equal to `sales`. */
  salesAsSold: productDetailSalesSchema.optional(),
  costCents: z.number().nullable(),
  /** Why `costCents` is null. Empty whenever a cost was resolved. */
  costIssues: z.array(expansionIssueSchema),
  marginCents: z.number().nullable(),
  marginPercent: z.number().nullable(),
  currencyCode: z.string(),
  incompleteManualRevenue: z.boolean(),
})

export const productDetailPayloadSchema = z.strictObject({
  item: productDetailSchema,
})

const forecastQuantitySchema = z.strictObject({
  quantity: z.number(),
  unit: z.string(),
})

const menuForecastProductSchema = z.strictObject({
  productId: z.string(),
  productPublicId: z.string(),
  productName: z.string(),
  isActive: z.boolean(),
  menuMember: z.boolean(),
  // How many of the eight history weeks the product sold in at all.
  weeksObserved: z.number().int().min(0).max(8),
  typicalQuantity: z.number(),
  busyQuantity: z.number(),
  /** The quantity the chosen plan expands into batches and materials. */
  totalQuantity: z.number(),
  seasonalFactor: z.number(),
  basis: z.strictObject({
    recentQuantity: z.number(),
    seasonalAdjustment: z.number(),
    busyAllowance: z.number(),
    lastYearComparable: z.boolean(),
    recentWeeks: z.array(
      z.strictObject({
        start: z.string(),
        end: z.string(),
        quantity: z.number(),
      })
    ),
    lastYearWeeks: z.array(
      z.strictObject({
        start: z.string(),
        end: z.string(),
        quantity: z.number(),
      })
    ),
    lastYearPeriod: z.strictObject({
      start: z.string(),
      end: z.string(),
      quantity: z.number(),
    }),
  }),
  days: z.array(
    z.strictObject({
      date: z.string(),
      typicalQuantity: z.number(),
      plannedQuantity: z.number(),
    })
  ),
  /**
   * The menu price the row is projected at and its share of the menu's money.
   * Null for an unpriced member, and for a product reached only through a
   * box or a modifier, whose money already sits in the base.
   */
  priceCents: z.number().int().nullable(),
  typicalCents: z.number().int().nullable(),
  busyCents: z.number().int().nullable(),
})

export const menuForecastPayloadSchema = z.strictObject({
  menu: z.strictObject({
    id: z.string(),
    publicId: z.string(),
    name: z.string(),
  }),
  basis: z.strictObject({
    timezone: z.string(),
    historyStart: z.string(),
    historyEnd: z.string(),
    horizonStart: z.string(),
    horizonEnd: z.string(),
    horizonDays: z.union([z.literal(7), z.literal(30)]),
    historyWeeks: z.literal(8),
    plan: z.enum(["typical", "busy"]),
    seasonalAdjustment: z.boolean(),
    compositionBasis: z.literal("current"),
    weeks: z.strictObject({
      recent: z.array(
        z.strictObject({
          start: z.string(),
          end: z.string(),
          units: z.number(),
          lastYearUnits: z.number(),
        })
      ),
      horizon: z.array(
        z.strictObject({
          start: z.string(),
          end: z.string(),
          typicalUnits: z.number(),
          plannedUnits: z.number(),
          lastYearUnits: z.number(),
        })
      ),
    }),
    level: z.strictObject({
      weeklyUnits: z.number(),
      seasonalFactor: z.number(),
      seasonalProducts: z.number().int().nonnegative(),
    }),
  }),
  coverage: z.strictObject({
    menuItems: z.number().int().nonnegative(),
    linkedMenuItems: z.number().int().nonnegative(),
    unresolvedMenuItems: z.number().int().nonnegative(),
    products: z.number().int().nonnegative(),
    productsWithHistory: z.number().int().nonnegative(),
    productsWithoutHistory: z.number().int().nonnegative(),
    inactiveProducts: z.number().int().nonnegative(),
    unresolvedPaths: z.number().int().nonnegative(),
  }),
  revenue: z.strictObject({
    currencyCode: z.string(),
    typicalCents: z.number().int(),
    busyCents: z.number().int(),
    plannedCents: z.number().int(),
    pricedProducts: z.number().int().nonnegative(),
    unpricedProducts: z.number().int().nonnegative(),
  }),
  /** The shopping list priced at pack prices; rows with no pack size or no
   * price are counted rather than read as free. */
  materialCost: z.strictObject({
    costCents: z.number().int().nonnegative(),
    costedMaterials: z.number().int().nonnegative(),
    uncostedMaterials: z.number().int().nonnegative(),
  }),
  production: z.strictObject({
    typicalUnits: z.number(),
    busyUnits: z.number(),
    plannedUnits: z.number(),
    recipeBatches: z.number(),
    productsPlanned: z.number().int().nonnegative(),
  }),
  days: z.array(
    z.strictObject({
      date: z.string(),
      typicalUnits: z.number(),
      plannedUnits: z.number(),
    })
  ),
  /** Menu-member units: 28 history days then the horizon, bridged on the last history day. */
  series: z.array(
    z.strictObject({
      date: z.string(),
      actualUnits: z.number().nullable(),
      typicalUnits: z.number().nullable(),
      plannedUnits: z.number().nullable(),
    })
  ),
  backtest: z.strictObject({
    weeks: z.array(
      z.strictObject({
        start: z.string(),
        end: z.string(),
        typicalUnits: z.number(),
        busyUnits: z.number(),
        actualUnits: z.number(),
      })
    ),
    scoredWeeks: z.number().int().nonnegative(),
    errorPercent: z.number().nullable(),
    busyCoveredWeeks: z.number().int().nonnegative(),
  }),
  products: z.array(menuForecastProductSchema),
  recipeRequirements: z.array(
    z.strictObject({
      recipeId: z.string(),
      recipePublicId: z.string(),
      recipeTitle: z.string(),
      batches: z.number(),
      days: z.array(z.strictObject({ date: z.string(), batches: z.number() })),
      /** What one batch makes; null when the recipe does not say. */
      yieldAmount: z.number().nullable(),
      yieldUnit: z.string().nullable(),
    })
  ),
  materialRequirements: z.array(
    z.strictObject({
      ingredientId: z.string(),
      ingredientPublicId: z.string(),
      ingredientName: z.string(),
      kind: z.enum(["ingredient", "supply"]),
      usage: z.array(forecastQuantitySchema),
      purchase: z.array(forecastQuantitySchema),
      /** The pack the ingredient is bought in, and how many of them this
       * demand takes, fractional: rounding up is the screen's decision. */
      purchaseSize: z.number().nullable(),
      purchaseUnit: z.string().nullable(),
      packs: z.number().nullable(),
      /** Packs at the pack price; null without a pack size or a price. */
      costCents: z.number().int().nullable(),
      /** The pack as the preferred supplier prints it, which is what the
       * kitchen orders by; null when no supplier item is preferred. */
      supplierPack: z
        .strictObject({
          supplier: z.string(),
          rawSize: z.string(),
          title: z.string(),
        })
        .nullable(),
    })
  ),
  unresolved: z.array(
    z.strictObject({
      code: z.string(),
      path: z.array(z.string()).optional(),
      // `issue_json` always emits the key; detail is null when the issue has none.
      detail: z.string().nullable().optional(),
      menuItemId: z.string().optional(),
      menuItemName: z.string().optional(),
      recipeId: z.string().optional(),
      ingredientId: z.string().optional(),
    })
  ),
})

export const menuItemsPayloadSchema = z.strictObject({
  items: z.array(salesProductSchema),
  meta: pageMetaSchema,
  /** Unfiltered existence, so a zero-match search is not an empty catalog. */
  hasAnyProduct: z.boolean(),
})

/** The menu worksheet's product picker: no page, no envelope, just rows. */
export const menuProductRowsPayloadSchema = z.strictObject({
  items: z.array(salesProductSchema),
})

/* -------------------------------------------------------------------------- */
/* menu/<ref>/                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One worksheet row: a link to a recipe or a product, or a plain named row
 * awaiting one. Name, category and food cost are the link's, read live; sell
 * price and (for recipe rows) qty sold are the row's own, with the source's
 * figures beside them so the worksheet can flag a difference.
 */
const menuItemRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  position: z.number().int().nonnegative(),
  sellPriceCents: z.number().int().nonnegative(),
  qtySold: z.number(),
  recipeId: z.string().nullable(),
  recipePublicId: z.string().nullable(),
  recipeName: z.string().nullable(),
  productId: z.string().nullable(),
  productPublicId: z.string().nullable(),
  productName: z.string().nullable(),
  /** The link's category; null on a row that has no link. */
  category: z.string().nullable(),
  /** Null when the source cannot be costed, or the row has no link. */
  foodCostCents: z.number().int().nullable(),
  sourceSellPriceCents: z.number().int().nullable(),
  /** The product's units sold over the menu's period; null for recipe rows. */
  sourceQtySold: z.number().nullable(),
  original: z.strictObject({
    sellPriceCents: z.number().int(),
    qtySold: z.number(),
    foodCostCents: z.number().int().nullable(),
  }),
})

export const menuDetailPayloadSchema = z.strictObject({
  menu: z.strictObject({
    id: z.string(),
    publicId: z.string(),
    editVersion: z.number().int().nonnegative(),
    name: z.string(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
  items: z.array(menuItemRowSchema),
  recipes: z.array(
    z.strictObject({
      id: z.string(),
      publicId: z.string(),
      title: z.string(),
      kind: z.string(),
      category: z.string().nullable(),
      menuPriceCents: z.number().nullable(),
      ingredientCents: z.number().nullable(),
      suffix: z.string(),
      batchMeasures: z.array(
        z.strictObject({ amount: z.number(), unit: z.string() })
      ),
      servingAmount: z.number().nullable(),
      servingUnit: z.string().nullable(),
    })
  ),
  ingredients: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      purchaseUnit: z.string().nullable(),
      nonEdible: z.boolean(),
    })
  ),
  products: z.array(
    z.strictObject({
      id: z.string(),
      publicId: z.string(),
      name: z.string(),
      componentProductIds: z.array(z.string()),
    })
  ),
  currencyCode: z.string(),
})

export const salesOverviewSchema = z.strictObject({
  /**
   * One currency throughout: sales and invoices are document money and are
   * never restated, so rows recorded in another code are excluded and counted
   * rather than summed in.
   */
  summary: z.strictObject({
    currencyCode: z.string(),
    lineCount: z.number(),
    quantity: z.number(),
    grossCents: z.number(),
    discountCents: z.number(),
    netSalesCents: z.number(),
    taxCents: z.number(),
    refundCents: z.number(),
    orderCount: z.number(),
    /** Tracked lines left out because they are in another currency. */
    excludedLineCount: z.number(),
  }),
  scope: z.strictObject({
    currencyCode: z.string(),
    pendingSkuCount: z.number(),
    pendingLineCount: z.number(),
    pendingNetSalesCents: z.number(),
    ignoredSkuCount: z.number(),
    ignoredLineCount: z.number(),
    ignoredNetSalesCents: z.number(),
    pendingModifierCount: z.number(),
    pendingModifierOccurrenceCount: z.number(),
    /** Identities left out because they are in another currency. */
    excludedSkuCount: z.number(),
  }),
  netSalesTrend: netSalesTrendSchema,
  dailySales: z.array(dailySalesSchema),
  /** Uncapped product/channel totals scoped to netSalesTrend's period. */
  topProducts: z.array(periodProductSalesSchema),
  imports: z.array(salesImportSchema),
  incompleteManualRevenue: z.boolean(),
})

/* -------------------------------------------------------------------------- */
/* invoice-suppliers/                                                          */
/* -------------------------------------------------------------------------- */

export const supplierSummarySchema = z.strictObject({
  id: z.string(),
  /** The normalized key the invoice, pantry and skip-list rows still carry. */
  key: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  accountNumber: z.string(),
  notes: z.string(),
  /** What this supplier's lines fall back to; null until the workspace says. */
  defaultCategoryId: z.string().nullable(),
  invoiceCount: z.number(),
  itemCount: z.number(),
  ignoreCount: z.number(),
})

export const invoiceSuppliersPayloadSchema = z.strictObject({
  items: z.array(supplierSummarySchema),
})

/* -------------------------------------------------------------------------- */
/* supplier-items/                                                             */
/* -------------------------------------------------------------------------- */

/** One remembered pack. `hasCode` is false when the key was derived from the
 *  description because the supplier printed no code. */
export const supplierItemRowSchema = z.strictObject({
  id: z.string(),
  supplier: z.string(),
  supplierName: z.string(),
  externalId: z.string(),
  hasCode: z.boolean(),
  title: z.string(),
  rawSize: z.string(),
  packPriceCents: z.number(),
  packAmount: z.number(),
  packUnit: z.string(),
  ingredientId: z.string(),
  ingredientName: z.string(),
  isPreferred: z.boolean(),
  timesSeen: z.number(),
  /** "YYYY-MM-DD", or null while no invoice line carries the pack. */
  lastInvoiceDate: z.string().nullable(),
})

/** A skipped key has no pack behind it, so it carries only its identity. */
export const supplierItemIgnoreRowSchema = z.strictObject({
  id: z.string(),
  supplier: z.string(),
  supplierName: z.string(),
  externalId: z.string(),
  hasCode: z.boolean(),
  title: z.string(),
  rawSize: z.string(),
})

/** `tab=items`: remembered packs. `total` is the whole filtered set, not the
 *  page. */
export const supplierItemsPayloadSchema = z.strictObject({
  items: z.array(supplierItemRowSchema),
  total: z.number(),
})

/** `tab=ignored`: the skip list, same envelope. */
export const supplierItemIgnoresPayloadSchema = z.strictObject({
  items: z.array(supplierItemIgnoreRowSchema),
  total: z.number(),
})

/* -------------------------------------------------------------------------- */
/* drive-folder/                                                               */
/* -------------------------------------------------------------------------- */

export const driveFolderSchema = z.strictObject({
  folderId: z.string(),
  folderName: z.string(),
})

export const driveFileSkipSchema = z.strictObject({
  driveFileId: z.string(),
  fileName: z.string(),
  reason: z.string(),
})

/** How the one Drive poller is doing, or null before it has ever run. */
export const driveWatchSummarySchema = z.strictObject({
  polledAt: z.string().nullable(),
  lastError: z.string(),
})

export const driveFolderPayloadSchema = z.strictObject({
  folder: driveFolderSchema.nullable(),
  skipped: z.array(driveFileSkipSchema),
  watch: driveWatchSummarySchema.nullable(),
})

/* -------------------------------------------------------------------------- */
/* drive-files/, system/drive-watch/                                           */
/* -------------------------------------------------------------------------- */

/** One document the Drive watcher read out of a file before anyone confirmed
 *  it. A file holds one of these normally and several when it turned out to be
 *  a bundle, each identified by its 0-based `part` and by the pages or the
 *  region of the file it was read from. `document` is opaque on the wire — the
 *  normalized invoice the watcher stored — because what the workspace knows
 *  about it (categories, duplicate, line matches) is recomputed when the inbox
 *  opens. */
export const driveFilePartSchema = z.strictObject({
  id: z.string(),
  part: z.number(),
  /** 0-based inclusive page range in the whole file; null for a photo region
   *  or a whole-file document. */
  pageStart: z.number().nullable(),
  pageEnd: z.number().nullable(),
  /** Fractions of the prepared photo, top-left origin; null for a PDF. */
  region: z
    .strictObject({
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
    })
    .nullable(),
  status: z.enum(["ready", "imported", "skipped"]),
  document: z.record(z.string(), z.unknown()),
  model: z.string(),
  escalated: z.boolean(),
  extractedAt: z.string(),
})

export const driveFileRowSchema = z.strictObject({
  driveFileId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nullable(),
  modifiedTime: z.string().nullable(),
  webViewLink: z.string(),
  folderPath: z.string(),
  status: z.enum([
    "new",
    "ready",
    "imported",
    "skipped",
    "failed",
    "unsupported",
  ]),
  reason: z.string(),
  invoiceId: z.string().nullable(),
  seenAt: z.string(),
  /** The documents read out of this file, `part` ascending. Only a `ready`
   *  row carries any. */
  parts: z.array(driveFilePartSchema),
})

/** `count` is every row in that status, not just the page. */
export const driveFilesPayloadSchema = z.strictObject({
  files: z.array(driveFileRowSchema),
  count: z.number(),
})

/** One connected folder, as the Drive watcher sees it. `registeredAt` is null
 *  until the watcher has listed that folder in full at least once. */
export const driveWatchFolderSchema = z.strictObject({
  userId: z.string(),
  folderId: z.string(),
  folderName: z.string(),
  registeredAt: z.string().nullable(),
})

/** The system read: the shared Changes cursor and every connected folder. */
export const driveWatchPayloadSchema = z.strictObject({
  pageToken: z.string(),
  polledAt: z.string().nullable(),
  lastError: z.string(),
  folders: z.array(driveWatchFolderSchema),
})

/* -------------------------------------------------------------------------- */
/* invoices/{publicId}/                                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* connector-sync-runs/                                                        */
/* -------------------------------------------------------------------------- */

/** Service-run timestamps intentionally remain ISO strings. */
export const connectorSyncRunSchema = z.strictObject({
  id: z.string(),
  providerKey: z.string(),
  remoteRunId: z.string().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.strictObject({
    pagesDone: z.number(),
    documentsSeen: z.number(),
    documentsImported: z.number(),
    documentsSkipped: z.number(),
    linesNeedingReview: z.number(),
  }),
  error: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const connectorSyncRunsPayloadSchema = z.strictObject({
  items: z.array(connectorSyncRunSchema),
})

export const connectorSyncRunPayloadSchema = z.strictObject({
  run: connectorSyncRunSchema,
})

/* -------------------------------------------------------------------------- */
/* activity/                                                                  */
/* -------------------------------------------------------------------------- */

export const activityResourceTypeSchema = z.enum([
  "recipe",
  "ingredient",
  "menu",
  "invoice",
  "category",
  "import",
  "settings",
  "connection",
  "workspace",
])

export const activityEventKindSchema = z.enum([
  "added",
  "edited",
  "deleted",
  "archived",
  "restored",
  "imported",
  "connected",
  "disconnected",
])

/** `createdAt` is on the reviver's allowlist, so it arrives as a Date. */
export const activityPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      actorName: z.string(),
      resourceType: activityResourceTypeSchema,
      resourceId: z.string().nullable(),
      event: activityEventKindSchema,
      name: z.string(),
      context: z.record(z.string(), z.unknown()),
      createdAt: z.date(),
    })
  ),
  nextBefore: z.string().nullable(),
})

/* -------------------------------------------------------------------------- */
/* invoices/<public_id>/                                                       */
/* -------------------------------------------------------------------------- */

/** The four wire values every workspace has; "" when the document does not
 *  say how it was paid. A workspace can define more, so the stored value is
 *  free text and Django is what checks it against the tenant's vocabulary. */
export const INVOICE_PAYMENT_METHODS = [
  "",
  "cash",
  "card",
  "bank_transfer",
  "on_account",
] as const

export const invoicePaymentMethodSchema = z.string()

/** `invoiceDate` stays a "YYYY-MM-DD" string; `createdAt` is on the reviver's
 *  allowlist and arrives as a Date. */
export const invoiceDetailSchema = z.strictObject({
  id: z.string(),
  publicId: z.string(),
  /** The optimistic-concurrency counter a save sends back as its expectation. */
  editVersion: z.number(),
  supplier: z.string(),
  supplierName: z.string(),
  documentType: z.enum(["invoice", "credit_memo", "receipt", "refund"]),
  invoiceNumber: z.string(),
  invoiceDate: z.string().nullable(),
  /** Null when the document printed no payment terms; never derived. */
  dueDate: z.string().nullable(),
  totalCents: z.number(),
  taxCents: z.number(),
  /** The printed subtotal before tax and charges; null when unprinted. */
  subtotalCents: z.number().nullable(),
  notes: z.string(),
  paymentMethod: z.string(),
  currencyCode: z.string(),
  /** "manual" for a hand-entered invoice, "connector" for a service import. */
  source: z.string().nullable(),
  fileName: z.string(),
  driveWebViewLink: z.string().nullable(),
  /** The Drive file the invoice was read from, so its page can show the
   *  document beside the lines; null for an upload or a typed-in invoice. */
  driveFileId: z.string().nullable(),
  /** The slice of that file, when the watcher read it as a bundle and this
   *  invoice is one document of it; null for a whole file. */
  driveFilePart: z
    .strictObject({
      part: z.number(),
      pageStart: z.number().nullable(),
      pageEnd: z.number().nullable(),
      region: z
        .strictObject({
          x0: z.number(),
          y0: z.number(),
          x1: z.number(),
          y1: z.number(),
        })
        .nullable(),
    })
    .nullable(),
  /** The uploaded file kept on our side, when the invoice came from one; null
   *  for a Drive file or a typed-in invoice. */
  documentKey: z.string().nullable(),
  lineCount: z.number(),
  matchedLineCount: z.number(),
  unresolvedLineCount: z.number(),
  createdAt: z.date(),
  lines: z.array(
    z.strictObject({
      id: z.string(),
      position: z.number(),
      sku: z.string(),
      description: z.string(),
      quantity: z.number().nullable(),
      unit: z.string(),
      packSize: z.string(),
      currencyCode: z.string(),
      unitPriceCents: z.number().nullable(),
      lineAmountCents: z.number(),
      categoryId: z.string().nullable(),
      categoryName: z.string().nullable(),
      ingredientId: z.string().nullable(),
      ingredientName: z.string().nullable(),
      priceUpdated: z.boolean(),
      needsReview: z.boolean(),
    })
  ),
})

export const invoiceDetailPayloadSchema = z.strictObject({
  item: invoiceDetailSchema,
})

export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>
export type InvoiceDetailLine = InvoiceDetail["lines"][number]
export type InvoicePaymentMethod = z.infer<typeof invoicePaymentMethodSchema>

/* -------------------------------------------------------------------------- */
/* kitchen-members/                                                            */
/* -------------------------------------------------------------------------- */

export const kitchenMembersPayloadSchema = z.strictObject({
  members: z.array(
    z.strictObject({
      id: z.string(),
      memberId: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.enum(["viewer", "editor"]),
    })
  ),
  invites: z.array(
    z.strictObject({
      id: z.string(),
      email: z.string(),
      role: z.enum(["viewer", "editor"]),
    })
  ),
})
