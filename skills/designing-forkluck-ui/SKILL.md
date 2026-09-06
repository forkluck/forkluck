---
name: designing-forkluck-ui
description: Design, implement, or review Forkluck interfaces for recipes, costs, ingredients, inventory, purchasing, labor, sales, invoices, menus, or settings. Use when chef workflow clarity, responsive layout, accessibility, design tokens, editor saves, or visual consistency matters.
---

# Designing Forkluck UI

Design for working chefs and operators: terminology, measurement basis, and saved state must be understandable during a busy service without requiring product knowledge.

## Start from the product

Before changing UI:

1. Read `AGENTS.md` completely, especially radius, semantic color, menu structure, control heights, and dialog widths.
2. Read the relevant Next.js guide under `apps/web/node_modules/next/dist/docs/` before writing framework code.
3. Inspect the existing page, neighboring workflows, and reusable primitives in `apps/web/components/ui`.
4. Read `docs/SAVE_SYSTEM.md` for drafts, registered header saves, navigation, optimistic state, errors, or undo.
5. For recipe or measurement UI, also use `costing-forkluck-recipes` and read `docs/INGREDIENT_MEASURES.md`.

Do not introduce a second design system, a one-off control height, an arbitrary radius, or a new semantic color for local convenience.

## Make the operational basis explicit

- Label quantities by what they control: production yield, costing portion, nutrition serving, purchase pack, received amount, or stock on hand.
- Show monetary and measurement bases beside derived values, such as cost per saved portion.
- Do not calculate through unresolved input and present the result as authoritative. Name the missing relationship and link to the place where it can be resolved.
- Keep destructive, external, or irreversible effects distinguishable from local drafts.
- Preserve the user's entered value while making invalid or incomplete state actionable.

Prefer concise product language. Do not mention competitors in product copy, fixtures, notes, comments, or persisted records.

## Use established interaction patterns

- Fields use the field border token and `rounded-md`.
- Buttons and popovers use `rounded-lg`; cards, dialogs, and empty states use `rounded-xl`.
- Controls use the prescribed height ladder; adjacent controls align on a common rung.
- Command menu rows have the established icon lane; value choices use check items.
- Use the registered header Save for editor-wide drafts instead of adding competing save domains.
- Collaborators remain read-only wherever existing permissions withhold cost or owner-only actions.

Responsive behavior must preserve the workflow, not merely stack desktop cards. Keep labels attached to their values, maintain reachable actions, restore focus after dialogs, and expose keyboard and screen-reader names for icon controls.

## Verify visually and behaviorally

Add component coverage for state transitions, permissions, invalid values, rollback, and keyboard interaction. Run targeted tests and type checking while iterating. Perform same-viewport visual QA in desktop and narrow layouts using the real application when practical, then run the repository verification required for the change's risk.
