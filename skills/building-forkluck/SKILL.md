---
name: building-forkluck
description: Build or change Forkluck features that cross the Next.js frontend, Django backend, internal HTTP contract, authorization, persistence, or background workers. Use for product implementation and architecture work; use a narrower Forkluck skill as well when recipe costing, integrations, UI, or deployment dominates the task.
---

# Building Forkluck

Work from the active Forkluck checkout. Do not treat this skill as a substitute for repository-local instructions.

## Load the source of truth

Before changing code:

1. Read the checkout's `AGENTS.md` completely.
2. Read `ARCHITECTURE.md` for process, request, and backend-layer boundaries.
3. Read the relevant guide under `apps/web/node_modules/next/dist/docs/` before writing Next.js code; this repository intentionally uses a version whose APIs may differ from prior knowledge.
4. Read `docs/CONTRACT.md` when a read model, mutation, timestamp, action slug, or public/internal route may change.
5. Read `docs/SAVE_SYSTEM.md` when changing editor drafts, registered saves, optimistic state, undo, or navigation guards.

If any document is absent, inspect the current checkout instead of importing rules from another Forkluck clone.

## Preserve the application seam

Forkluck is one product with separate Next.js and Django processes:

- Next.js renders pages and is the sole caller of Django's internal data API.
- Django owns identity, authorization, persistence, integrations, and the staff console.
- Browser-facing writes use a Next Server Action which validates and calls the single Django action endpoint.
- Django domain handlers own mutations. Routes and dispatch do not own business logic.
- User-owned reads and writes must select through the authenticated owner or tenant; an object id alone is never authorization.

For a new mutation, trace and update every applicable link:

1. Django domain handler and domain `ACTIONS` registry.
2. Composed action registry and `EXPECTED_ACTIONS` contract pin.
3. `docs/CONTRACT.md`.
4. Next Server Action validation, backend call, error conversion, and route revalidation.
5. TypeScript response types or schemas when the wire shape changes.
6. Tests for authorization, malformed input, success, and downstream state.

Keep backend imports flowing in the direction defined by `ARCHITECTURE.md`; do not solve an import boundary by introducing a reverse dependency.

## Change the whole invariant

Before implementation, identify:

- the owning domain and authenticated identity;
- every create, read, update, duplicate/import/undo, merge, and delete path affected by persisted state;
- every list, dashboard, export, nested calculation, worker, or external effect consuming the state;
- whether equivalent behavior exists in both TypeScript and Python;
- whether a wire contract or timestamp reviver changes.

Extend the existing invariant matrix for cross-cutting behavior. Test the accepted input families and unresolved states, not only the reported example.

## Verify proportionally

Run targeted tests while iterating. Before handing off a cross-layer change, run the repository-prescribed frontend and backend verification, migration check, and import-linter. Review the complete diff and preserve unrelated user changes in a dirty worktree.

Do not commit, push, deploy, contact providers, or alter production merely because implementation is complete. Those remain separately authorized actions.
