# Ingredient Measure Research and Default Policy

## Decision

Forkluck supports deterministic volume-to-weight conversion without runtime AI.
The parser recognizes quantity, unit, ingredient, and preparation qualifier first.
It resolves a gram weight only after matching the ingredient.

The shared catalog is the open data under `data/catalog/` (CC0, built from USDA
SR Legacy; see its README), loaded by `manage.py sync_catalog`. Private
operational catalog data — prices, suppliers, customers — is still never
committed to this repository.

## Measurement standards

Recipe volume uses exact U.S. customary-to-SI factors internally and rounds only
for display:

| Unit        | Internal milliliters |
| ----------- | -------------------: |
| teaspoon    |        4.92892159375 |
| tablespoon  |       14.78676478125 |
| fluid ounce |        29.5735295625 |
| cup         |          236.5882365 |
| pint        |           473.176473 |
| quart       |           946.352946 |
| gallon      |          3785.411784 |

Metric units are exact: 1 mL, 10 mL per cL, 100 mL per dL, and 1,000 mL
per liter. An account's display preference must never reinterpret an existing
recipe.

## Source policy

Use public-domain government food-portion data as the primary shared source.
Foundation records are analytically focused but have limited household-measure
coverage. The final Standard Reference release has broader ordinary-ingredient
coverage. Survey-food data is useful for prepared foods, while branded records
apply only to an exact product match.

Preparation-yield data is separate from volume-to-weight data. Trimming, peeling,
draining, cooking, and purchase-to-ready yield factors must not be mixed into a
cup-to-gram record.

Every imported observation retains its source kind, source reference, release,
derivation method, evidence count, confidence, and optional low/high range.

## Resolution precedence

1. Explicit recipe weight, such as `1 cup (120 g) flour`.
2. A user-saved measure for the matched pantry ingredient and qualifier.
3. An exact branded-product measure.
4. A direct shared portion with the same ingredient, state, qualifier, and unit.
5. A reviewed catalog default derived from compatible evidence.
6. A same-source density inference for another volume unit.
7. For a matched, qualifier-free ingredient still using standard conversion,
   the disclosed product convention: 8 oz-weight equals 1 cup.
8. Unresolved: ask the user when the line is unmatched, qualified, or has a
   custom conversion that does not relate the requested units.

A direct same-unit record beats density inference. If both cup and tablespoon
records exist, a tablespoon input uses the tablespoon record.

The final standard convention is a low-confidence working estimate, not food
evidence and not an assumption that the ingredient is water. A chef-entered
conversion replaces it completely.

## Default calculation

Evidence may be combined only when all of these match:

- canonical ingredient;
- brand or generic status;
- raw, cooked, canned, drained, frozen, or dried state;
- physical form: whole, sliced, diced, chopped, minced, grated, shredded, ground;
- packing method: loose, packed, sifted, spoon-and-level, or unspecified;
- canonical unit and volume standard.

Within a compatible group:

1. Normalize each observation to grams per canonical unit.
2. Count duplicate representations from one source as one observation.
3. Preserve reported ranges rather than pretending the midpoint was measured.
4. Prefer a direct public portion when available.
5. Otherwise use the median of at least two compatible reputable observations.
6. Differences above 10% require review and preserve a low/high range.
7. A single reputable observation remains low confidence and user-overridable.

The UI calls a shared value an estimate, not an exact physical truth.

## Stored data

Shared measures retain:

- canonical ingredient;
- unit and amount;
- grams and optional low/high grams;
- state or preparation qualifier;
- source kind, reference, and release;
- derivation method and evidence count;
- confidence, active status, and default status.

Tenant-owned measures live separately and always override shared estimates. Every
read and write is scoped through the authenticated user's ingredient.

## Import manifest

Run:

```bash
cd backend
.venv/bin/python manage.py import_ingredient_measures /secure/path/measures.json
```

The manifest is a JSON array:

```json
[
  {
    "ingredient": "Example flour",
    "unit": "cup",
    "amount": 1,
    "grams": 125,
    "qualifier": "",
    "source_kind": "public_food_data",
    "source_ref": "record-id",
    "source_release": "release-id",
    "derivation": "direct",
    "evidence_count": 1,
    "confidence": "high",
    "is_default": true,
    "is_active": true
  }
]
```

Use `--dry-run` to validate without retaining database changes. The importer is
idempotent for the same ingredient, unit, qualifier, source kind, and source
reference.

## Preparation-yield manifest

Yields live in their own table and their own manifest, never mixed into a
cup-to-gram record. Run:

```bash
cd backend
.venv/bin/python manage.py import_preparation_yields /secure/path/yields.json
```

The manifest is a JSON array:

```json
[
  {
    "ingredient": "Garlic",
    "name": "Minced",
    "yield_percent": 80,
    "low_percent": 76,
    "high_percent": 84,
    "source_kind": "public_food_data",
    "source_ref": "record-id",
    "source_release": "release-id",
    "derivation": "direct",
    "evidence_count": 2,
    "confidence": "medium",
    "is_default": true,
    "is_active": true
  }
]
```

Every provenance key is required: a yield with no source, release, derivation
and evidence count is not reviewable. `yield_percent` is above zero and at most
1000 — a preparation that hydrates or cooks up passes 100% honestly, ten times
does not. `low_percent` and `high_percent` are optional and come as a pair.

Use `--dry-run` to validate without retaining database changes. The importer is
idempotent for the same ingredient, preparation name, source kind, and source
reference.

A default yield seeds the preparation a tenant creates without stating one: the
row is stored `source: "catalog"` with the shared confidence, and the UI calls
it an estimate. Saving that preparation again makes it the tenant's own, at
`source: "user"` and high confidence, and no later import touches it.

## Acceptance rules

- No valid volume ingredient is silently skipped.
- No unmatched name carries a weight it did not state: an unmatched line is
  read as an amount of something unknown, never as water, as a typical
  density, as a profile each-weight, or as that many grams.
- Explicit recipe weights and user measurements always win.
- Preparation qualifiers do not collapse into a generic ingredient. A bare
  phrase such as `almond sliced` or `sliced almond` remains that complete
  identity; punctuation such as `almond, sliced` or `almond (sliced)` is what
  makes `sliced` a preparation annotation.
- A display-system setting change does not alter recipe weights or costs.
- Internal calculations retain precision and round only for display.
- Every shared default is traceable to a source and release.
- Large source disagreements produce review state, not false precision.
- Tenant-isolation tests cover reads, writes, and ingredient merging.

## Implementation invariant matrix

Line syntax is pinned by the corpus, not prose: every supported form — unit
aliases, size words, word order, pasted characters, second amounts, restated
parentheticals, ambiguous ounces, method ranges, container counts, decimal
commas — is a row in `apps/web/tests/fixtures/recipe-lines.json`, read identically by
`apps/web/lib/recipe/parse.ts` and `domains/recipes/health.py`. New syntax lands as a
corpus row, not a one-sided example. Every corpus line is parsed with no
ingredients in hand, so a row asserts grams only where the text itself states
the mass; a weight that depends on a matched identity is proved by a test that
hands the parser that identity.

The rows below cross layers and cannot be expressed as a corpus line. A change
touching one is complete only when traced through parser, identity resolution,
persistence, pricing, and UI, with both sides of each changed branch exercised
(for example: merge with and without a target measure, exact identity versus
alias, direct measure versus derived measure).

| Boundary               | Required invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical units        | Every value in `RECIPE_MEASURE_UNITS` is accepted by the parser and by both Django measure models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Identity               | The ingredient or recipe selected for a conversion is the same direct target selected for price. A real pantry/recipe target beats an alias; an alias beats a catalog-only estimate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Renames                | Pantry display-name changes do not detach an adopted ingredient from its canonical shared-measure identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Precedence             | Explicit weight > user override > exact shared measure > compatible derived shared measure > shared density chart estimate for the matched ingredient, qualifier-free > disclosed 8 oz-weight-per-cup standard estimate > unresolved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Uncertainty            | Low/high ranges scale with quantity and remain visible as estimate/review state downstream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Lifecycle              | Create, read, update, merge, import undo, and delete preserve or intentionally remove user measures. A saved measure makes an imported ingredient durable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tenant boundary        | All user-measure reads and writes scope through the authenticated user's ingredient; catalog measures contain no tenant data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Downstream state       | Resolved, estimated, review, and unresolved states agree across recipe parsing, costing, health, and editor interaction. A priced ingredient whose recipe unit cannot reach its purchase unit is a conversion problem, never a missing-price prompt: the Cost tab names the mismatch and returns the user to the Recipe tab. Catalog estimates remain user-overridable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Read-model parity      | The TypeScript editor/pricing parser and Django recipe-health/dashboard parser agree on supported units, identity precedence, explicit weights, unresolved ranges, and estimate-review state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Recipe targets         | Any ordinary recipe may be selected and badged as a recipe in an ingredient row. Count lines use entered count × nested batch cost ÷ declared count yield; weight yields convert by declared yield units. The retired sellable-yield column is ignored until its later schema-drop release. No separate component designation participates. Cycles are rejected while shared descendants in a DAG remain valid. The owner detail and Cost tab use the saved recipe id for each line and expose the same recursive contribution; display-name matching never replaces that identity, while collaborator reads expose no line costs. Renaming a recipe updates parent line names that still equal its old canonical title and bumps those parent edit versions; deliberately different line text remains flagged for attention.                     |
| Recipe UOM equivalency | Total Yield is authoritative for its own family. In a custom (`standard=false`) equivalency, every other filled amount describes that same whole finished batch; the yield-family slot is cleared on write and locked in the editor. In a standard (`standard=true`) equivalency, the stated weight and volume are a reusable density ratio, remain intact even when one shares Total Yield's family, and scale from Total Yield before any batch amount is read. An explicit finished mass overrides an incomplete ingredient-weight sum; without it, a mass use stays unresolved and names the excluded lines rather than treating raw input weight as finished weight. Nested costing, weighing and nutrition use the same mode and ratio. Volume yields normalize to cost per liter without requiring a mass equivalency.                     |
| Recipe portions        | A portion describes one serving and never writes or replaces a whole-batch UOM equivalency. Cost per portion divides the batch by the serving only when the serving's family is stated by the yield or an explicit equivalency. A count yield and a mass or volume portion remain unresolved until that relationship is recorded; neither value silently defines the other. An absent or otherwise unresolved serving stays null and never assumes one piece or one whole batch. Recipe lists, dashboards, menu pricing and exports use that same saved portion for commercial cost and food cost. A batch lens multiplies yield, equivalency and portion count together while leaving the size and cost of one portion unchanged. Parent recipes price a nested line from the child yield and equivalency, never from the child's portion. A product component sold in `portion` or `serving` is the one exception: it is a sale of the saved portion, so it divides by the recipe's saved portion when no equivalency counts portions, and by the equivalency when one does. |
| Auto yield             | An explicit total-yield unit always wins. With auto-yield enabled and no unit chosen, every formula adopts grams. Weight, volume, count, mixed, and nested lines convert to grams through the same linked ingredient or recipe equivalencies used elsewhere; an unresolved line names the missing conversion instead of being omitted. The sum recomputes when a line or conversion changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Counts                 | A bare count of a matched ingredient whose profile knows its each-weight converts by that weight, never to that many grams; with no matched identity the line keeps no unit and no weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Count packs            | A supplier pack bought by the piece ("4X12 CT" is 48 each) is stored and priced in that count, and its cached `packGrams` is null. A recipe line measured by weight reaches it only through the ingredient's own each↔weight conversion; without one the line stays unpriced rather than guessing a piece weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Invoice prices         | Connecting an invoice line records an alternative price and its exact pack size/unit without changing the ingredient's active cost, yield, conversion, or supplier default. One line may independently price several ingredients (for example Egg and Egg yolk). Only the explicit “Use for costing” action copies that line's derived per-pack price and measure into one ingredient; each ingredient keeps its own yield and conversions. Import undo removes automatic references but preserves references the user explicitly kept.                                                                                                                                                                                                                                                                                                           |
| Unmatched names        | A line asserts grams only when the text states the mass (a mass unit, or a weight written in the line) or a matched identity supplies the conversion. The density chart, the each-weight profile and the bare-number reading all require the match, in both engines. The line stays in the parsed rows with its amount and name; it is never demoted to a skipped line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Standard conversion    | The row's own six measures answer whenever it states any; a row on the standard conversion states none, and then a known shared density or, last, the disclosed 8 oz-weight-per-cup estimate bridges mass and volume for the matched ingredient, qualifier-free, reported as an automatic conversion. A custom conversion disables both automatic answers when its own measures cannot relate the requested families. Both engines agree.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stated conversion      | The row's own measures are one equivalence about the ingredient and not a description of the pack: 227 g of butter is 1 cup of butter, whether the pack is a 1 lb block or a 25 kg drum. A line whose unit the purchase unit relates to converts directly. Otherwise the line becomes a share of the measure stated in its own family, that share is taken of the measure stated in the family the pack is bought in, and the purchase size divides. When nothing stated reaches the purchase unit, the pack is the equivalence's other side only where the row states a single measure (a 700 g batch that is 2.75 cup) or the pack is a container with no universal size (a case that holds 36); two stated measures already relate each other, so reading the pack into them would be a guess and the line stays unpriced. Both engines agree. |
| Preparation identity   | Each comma- or semicolon-delimited clause in a line's note is normalized independently and offered to the matched ingredient's preparations. Equality is exact: "finely minced" does not answer "minced", nor the reverse. An unqualified line matches no preparation; a note with no exact preparation clause uses the ingredient as bought. TypeScript pricing/weighing and Python current, temporal, and nutrition reads use this same rule.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Line attention         | A normalized line with no saved ingredient or recipe identity is unresolved. A linked line whose normalized display name differs from its linked ingredient name or recipe title has stray words; case, accents, punctuation, and spacing compare through the shared TypeScript/Python name normalizer, while a saved preparation remains in the preparation note. The editor and owner recipe list flag the same states, and shared rows expose no cost-derived issue. Existing preparations remain selectable from the recipe line, while new preparations are created only from their ingredient page.                                                                                                                                                                                                                                         |
| Preparation conversion | Select one owner before converting. A line unit compatible with the purchase unit needs no conversion. With no preparation, the ingredient owns the conversion. A standard preparation has no pairs and uses the ingredient's stated conversion plus the qualifier-free standard ladder. A custom preparation owns the conversion exclusively: only its pairs may relate the requested families, and an empty or incomplete custom conversion stays unresolved instead of inheriting ingredient pairs, density, saved measures, or parser-inferred grams. A weight explicitly written in the recipe remains usable.                                                                                                                                                                                                                               |
| Preparation yield      | `yieldPercent` is a mass factor applied to the resolved sale units in the buying direction: 100 g of an 88% preparation is 113.6 g bought, so `saleUnits × 100 ÷ yieldPercent`. It applies on every branch, including a direct sale-unit hit, whenever a preparation matched and its percent is finite and above zero — a prep with only a yield still changes the price. Both engines agree, and neither borrows an ingredient's yield for an unqualified line.                                                                                                                                                                                                                                                                                                                                                                                  |
| Seeded yield           | A preparation created without a yield takes the reviewed shared default for the ingredient's canonical identity and is stored `source: "catalog"` with that row's confidence; a stated yield is never replaced. Saving the preparation again writes `source: "user"` at high confidence and no import touches it after that. The tag travels on the wire only — both engines cost the stored percent identically, seeded or measured.                                                                                                                                                                                                                                                                                                                                                                                                             |

A preparation yield is blank or greater than zero and at most `1000%`. Each
custom weight, volume, or count measure is either wholly blank or a positive
amount paired with a nonblank unit. A standard preparation stores no custom
measures. Empty custom conversions are valid and deliberately unresolved.

## Temporal recipe-cost invariant matrix

| Boundary               | Required invariant                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syntax                 | `from` is absent or exactly `YYYY-MM-DD`; Django rejects malformed and future dates. Qwen's tool schema applies the same syntax, but Django remains authoritative.                                                                                                                    |
| Time                   | One `toAt` is captured per request. Default `fromAt` is midnight UTC 90 calendar dates earlier; an explicit date is midnight UTC. A price event belongs to the window only when `fromAt < effectiveAt <= toAt`.                                                                       |
| Identity and ownership | The route first selects an owner-scoped recipe by public id. Shared and foreign recipes are indistinguishable from missing recipes. Nested ingredients retain their saved identities; display names never select price history.                                                       |
| Basis                  | Both instants use today's normalized recipe/subrecipe graph, quantities, efficiencies, preparations, conversions, and yields. This is always labeled `priceOnlyCurrentRecipeBasis`, never historical recipe reconstruction.                                                           |
| Price selection        | Each relevant ingredient uses the latest recorded price at or before each boundary. Backdated invoice prices participate by `effectiveAt`, not row creation time. The history scan is ordered once for all relevant ingredients.                                                      |
| Inclusion              | Headers, notes, explicitly excluded cost lines, missing quantities, unresolved identities, and cycles cannot silently enter a complete total. Their line state and issue remain visible.                                                                                              |
| Completeness           | A complete boundary total exists only when every required line is priced there. Comparable totals use the intersection priced at both boundaries; they never masquerade as the full recipe total.                                                                                     |
| Empty window           | Event count includes nested relevant ingredients. Zero events returns the latest selected observation at or before `fromAt`, if one exists. An event sequence returning to its starting value is activity with zero net delta, not an empty window.                                   |
| Query behavior         | The normalized graph is loaded once and all relevant `IngredientPrice` history is one ordered scan. With measure caches warm, nested recipe depth does not grow the endpoint's pinned query count.                                                                                    |
| Model boundary         | The server fixes recipe identity and forces one read-only tool call. Old browser tool/reasoning/file/data parts are removed; prior assistant prose may carry a complete offered date. Django's card is authoritative and the model performs no independent cost arithmetic.           |
| UI lifecycle           | The resolved period and current-recipe basis appear on every card. Recipe navigation aborts streaming and starts a fresh keyed conversation; non-recipe pages disable composition. Desktop rail, mobile dialog, stop/retry, and focus restoration preserve the same result semantics. |

## Nutrition invariant matrix

| Boundary       | Required invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine         | One rollup, in Python, over the normalized recipe lines (`domains/recipes/nutrition.py`). The paste-analysis model in `apps/web/lib/recipe/` estimates composition for the editor; it never builds a label preview. TypeScript formats what the backend returns and sums nothing.                                                                                                                                                                                                                                              |
| Identity       | A line weighs what it costs: `RecipeHealthReadModel.line_grams` climbs the ladder `ingredient_cents` climbs (a mass unit directly, the stated pairs through the pack, then saved and shared measures), with yields left out, because the line says what went into the bowl, and without a price, because unpriced food still weighs.                                                                                                                                                                                  |
| Ownership      | Search is authenticated; set, clear, settings and custom requests scope the ingredient through its owner. A shared viewer reads the rollup through the owner's pantry and receives names, statuses, net grams, allergens, totals, statement and readiness: no pantry ids, no source descriptions, no links to recipes they cannot open.                                                                                                                                                                               |
| Persistence    | The stored source (`usda_fdc` or `custom`), its id, description, per-100 g snapshot and refresh time move with the ingredient through merge and disappear on delete. A custom request is a row first and an email second; applying it refuses to overwrite a record the user linked after asking unless staff force it.                                                                                                                                                                                               |
| Not food       | `non_edible` means packaging or equipment. The line contributes no nutrients, no ingredient-statement entry and no allergens.                                                                                                                                                                                                                                                                                                                                                                                         |
| Retention      | `efficiency_after_cooking` is the share of a line that stays in the dish, 0..100, bounded in the editor schema, the save handler, model validation and the database together. Net grams are line grams times that share. Zero is a discarded brine: no nutrients and no statement entry, while its allergens stand as tagged, because an ingredient the kitchen chose has no threshold. Costing ignores the field.                                                                                                    |
| Unknown values | A nutrient a record does not report is unknown, never zero. Every total carries `{amount, complete}`; an incomplete amount is the sum of what is known, printed plainly on the label while the note beneath names it as understated. Added sugars come from an ingredient flagged `sugars_are_added`, where they equal its sugars, and read zero on a Foundation or SR Legacy record that states none; a branded record's blank line stays unknown.                                                                                                                                                                                                                                       |
| Water rule     | Nutrients are never rescaled. Batch grams are the declared finished weight (a mass yield or the equivalency mass) when stated, else the net input sum, and every per-serving and per-100 g figure divides by that.                                                                                                                                                                                                                                                                                                    |
| Nested recipes | A nested recipe rolls into its parent scaled by the line's net grams over the child's batch grams, its statement expanded into the parent's. A child with a blocking issue, no batch weight, or a line unit its yield cannot relate blocks the parent with a named issue rather than a guess. Cycles mark the line incomplete and never raise.                                                                                                                                                                        |
| Serving        | The label serving is `nutrition_serving_amount/unit`, separate from the cost serving. A mass unit reads directly; a count or volume unit reads through the recipe's piece or volume basis (its yield or equivalency); anything else is a named issue.                                                                                                                                                                                                                                                                 |
| Package        | The optional retail package is `nutrition_package_amount/unit`, owner-set and copied with the recipe. Both values are set or cleared together. When unset, one batch is one container; when set, `batch.servings` is servings per package and `batch.containers` is packages per batch. An unrelatable package nulls only those counts, never nutrient totals.                                                                                                                                                        |
| Readiness      | Batch issues null every total. Serving issues null only the per-serving column. Each format (US, EU) is ready when no batch issue stands and its mandatory nutrients are complete; an unready format still renders its known sums, with the missing nutrients named beneath the label.                                                                                                                                                                                                                      |
| Allergens      | Nineteen kitchen tags roll up through nested recipes with contains outranking may-contain. A preview's CONTAINS line declares only the selected format's regulated subset; the rest show as kitchen tags. Nothing here is a regulated declaration: species naming and thresholds are out of scope. Allergen hints, read off a package's ingredient text or marked brand-dependent by the catalog, are suggestions for the kitchen to confirm and never assertions: nothing rolls up, filters or declares from a hint. |

## References

- NIST exact conversion factors: https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9
- FDA household-measure guidance: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/guidance-industry-guidelines-determining-metric-equivalents-household-measures
- USDA FoodData Central API and licensing: https://fdc.nal.usda.gov/api-guide/
- USDA FoodData Central downloads: https://fdc.nal.usda.gov/download-datasets/
- USDA data-type comparison: https://fdc.nal.usda.gov/data-documentation/
- USDA Food Buying Guide: https://foodbuyingguide.fns.usda.gov/Home/About
