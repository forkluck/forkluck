---
name: costing-forkluck-recipes
description: Implement, diagnose, or review Forkluck recipe quantities, units, yields, portions, equivalencies, ingredient costing, nested recipes, nutrition rollups, menu pricing, or recipe-health outputs. Use whenever measurement semantics or TypeScript/Python costing parity can change.
---

# Costing Forkluck Recipes

Use the active Forkluck checkout as the source of truth.

## Required context

Before planning or changing behavior:

1. Read `AGENTS.md` completely.
2. Read the relevant sections of `ARCHITECTURE.md`.
3. Read `docs/INGREDIENT_MEASURES.md` completely. It is the required invariant matrix, not optional background.
4. Read `docs/CONTRACT.md` if a recipe read model, health issue, action payload, export, or timestamp changes.
5. Locate the matching TypeScript and Python implementations before deciding where a fix belongs.

## Keep the meanings separate

Do not collapse these concepts:

- **Total Yield** describes the finished production batch.
- **UOM equivalency** relates physical measures of that whole batch or an ingredient.
- **Commercial Portion Size** describes the amount being costed and sold.
- **Nutrition Serving Size** belongs to nutrition labeling and is persisted separately.
- **Batch Size** is a viewing or production scale and must not silently change the saved cost of one portion.

Never infer a cross-family conversion merely because both numbers exist. For example, a count yield and gram portion require a stated relationship before commercial cost resolves. Missing or unresolvable information stays null with a specific issue; it does not become one piece, one portion, one batch, or raw-input weight.

## Preserve precedence and identity

- Use the identity selected by the normalized recipe line; display-name matching must not independently choose a price or conversion.
- A line's explicit measure and exact preparation identity outrank generic conversions.
- A custom preparation owns its conversion exclusively and does not inherit an ingredient conversion when incomplete.
- Ingredient yield percentages affect buying quantity and cost, not the physical amount entered into the bowl for nutrition.
- Commercial portion settings never alter how a child recipe is priced inside a parent. Nested pricing uses the child's production yield and equivalency.
- Nutrition rolls up through its own serving and finished-batch rules; costing fields do not silently populate nutrition fields.

## Maintain engine parity

Trace commercial outputs through both engines and every consumer:

- TypeScript editor/costing and recipe health;
- Python normalized health, dashboard, list, menu, and export reads;
- recipe Cost UI, list basis labels, food-cost percentage, profit, and suggested price;
- nested recipes and nutrition where the same measurement primitives are reused.

Add a parity matrix covering the relevant combinations: count, mass, and volume; same-family and cross-family; standard and custom equivalencies; missing yield or portion; batch scaling; unresolved lines; and nested recipes.

Use unrounded cost for calculations and round only at the specified display or persistence boundary. Food cost and profit remain ingredient-only unless the product requirement explicitly expands their basis.

## Verify the behavior

Run focused unit and component tests during implementation. For a cross-engine change, run the full frontend and backend verification required by `AGENTS.md`, then inspect the complete diff against the measurement matrix. When practical, exercise one realistic recipe in the UI and confirm the Cost tab, recipe table, dashboard, and export agree.
