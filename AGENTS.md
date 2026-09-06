<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Repository layout and boundaries

`ARCHITECTURE.md` is the single home for the repository layout, the two-process
model, the request lifecycle, the backend layering, and how to add an action.
`docs/CONTRACT.md` is the authoritative description of the HTTP surface between
the two processes. import-linter enforces the layering:

```bash
(cd apps/api && .venv/bin/lint-imports)
```

## Simplicity

Overengineering is a defect. Solve the stated problem with the least code that
fully works.

- No abstraction — layer, interface, wrapper, base class, config option — until
  at least two concrete users exist, in already-merged code or in this same
  change.
- No code for hypothetical future needs. Build for the requirement in front of
  you; when a future need actually arrives, code for it then.
- Prefer deleting code over adding it, and extending an existing module over
  creating a new one.
- Prefer framework and stdlib built-ins over new dependencies.

## Cross-cutting change pre-review

This checklist is for the author preparing a change. Reviewers do not apply it;
reviewers follow only the Code Review Rules below.

Before marking a cross-layer change ready or requesting external review:

1. Review the complete branch diff against its base, not only the latest commit.
2. Write or update an invariant matrix for the affected behavior. Cover syntax
   forms, identity and ownership, precedence, lifecycle, and downstream states.
3. Test the cross-product at boundaries. One test for the reported example is
   not enough when the same branch accepts multiple units, identities, or data
   sources.
4. Trace every new persisted relation through create, read, update, merge,
   import/undo, and delete. Trace every new unresolved or review state through
   pricing, health/status calculation, and UI interaction.
5. Keep identity selection centralized when two consumers must agree. For
   example, recipe conversion and ingredient pricing must use the same matched
   ingredient rather than independently repeating name/alias precedence.
   When behavior necessarily exists in both TypeScript and Python read models,
   add parity cases for the same syntax, precedence, and unresolved states.
6. Run the relevant frontend tests and typecheck plus the backend tests,
   migration check, and import-linter. Run the full suites when the diff crosses
   the Next/Django contract or changes persistence.
7. Perform one consolidated adversarial pass over the final diff before asking
   for review. Treat review comments as evidence of a missing invariant and add
   the broader guard/test, not only the literal example.

For recipe measurement work, the required domain matrix lives in
`docs/INGREDIENT_MEASURES.md`.

## Radius

Five steps exist and nothing between them: `rounded-sm` (4px), `rounded-md`
(6px), `rounded-lg` (10px), `rounded-xl` (14px), `rounded-2xl` (18px), plus
`rounded-full`. They are declared in `apps/web/app/globals.css`.

An arbitrary radius — `rounded-[10px]`, `rounded-[5px]`, `rounded-[13px]`, any
of them — is never correct, including when it matches a step's current value.
A call site that spells the number out stops tracking the scale the moment the
scale moves, which is how the app ended up drawing twelve distinct radii from a
five-step system. Pick the nearest step; if none of the five is right, the
change is to the scale, not to the call site.

Buttons and popovers are `rounded-lg`; **fields are `rounded-md`** — a control
you type into is squarer than one you press, and that difference is the whole
reason both steps exist. Cards, dialogs and the empty state are `rounded-xl`.
Every size of a button rounds on the same step, icon-only included, so a
toolbar of mixed sizes shares one corner.

A field is anything wearing `border-input`. Fields hand-rolled onto
`border-border` are how the app came to draw two different field edges side by
side; name the field token and the field follows the field.

## Semantic color

One red and one green, each in two parts: the ink and the pale fill it sits on
(`--destructive` / `--destructive-fill`, `--success` / `--success-fill`). Do
not add a second shade for a state that "reads softer" than an action — the app
carried a second red and a second green on that theory and the cooler green
failed AA against 11.5px text on its own fill. A new semantic color needs a
contrast check against every ground it lands on, in the pull request.

Blue (`--brand`) is data and selection only: chart marks, progress fills, the
icon tile, the fill of a selected card. Filled buttons are ink, never blue.

## Menus

A row that runs a command carries a 17px icon; a row that picks a value is a
`MenuCheckItem` and carries the 15px check slot instead. Every row has one or
the other, and never neither.

The icon is structural, not decorative. Icon plus gap is a 27px lane, so a row
without one starts its label 27px further left, and two menus opened from
neighbouring controls disagree about where their text begins. Mark the icon
`aria-hidden` — the label already names the action. Reuse the verb's existing
icon rather than picking a new one: `SquarePen` edits, `Trash2` deletes,
`Download` imports, `Upload` exports, `Clock` is history.

## Feedback

A press that waits on the server shows the wait on the control that was
pressed, from the press until the screen reflects the result. The button takes
`pending`; a field that saves itself goes through `useCommit` and the
`SaveStatus` pill; content a control is about to replace sits in a
`LoadingRegion`; a filter pill that navigates takes `pending` from the
transition that carries its `router.replace`.

`router.refresh()` is part of that wait, not the end of it. It is only ever
called through `useRefresh`, which runs it inside a transition: `pending`
stays up until the new payload has committed, and `await refresh()` is the
moment a dialog may close or a toast may say the thing is done. Before this
was enforced, sixty sites called it bare, the spinner stopped when the action
answered, and the old rows sat on screen for the round trip that followed,
which is the moment that reads as "did that work?".

Inside an async React transition, call `void refresh()` rather than awaiting
it: React joins their pending work, so awaiting the refresh there makes the
transition wait on itself. Follow-up UI work can use an unreturned `.then()`.

A `useTransition()` whose `isPending` is discarded is a bug, not a shortcut.
An action chosen from a menu reports back, with a toast or a row that visibly
changed, because the menu that closed is the only feedback the click had.
`apps/web/tests/feedback-pins.test.ts` holds both lines.

## Control heights

Five rungs, and a control sits on one of them: **20px** (badges and chips),
**24px** (`xs`), **28px** (`sm`), **32px** (`default`), **36px** (`lg`). The
icon sizes are the square counterparts at the same heights, so an icon button
and the text button beside it line up without either being special.

32px is the hinge the toolbar is built on — buttons, the search field and the
tab-pill track all resolve to it, and every menu hangs 6px under its trigger.
Before this was enforced the app drew fifteen control heights, and the 2px
gaps between them bought nothing: a 30px icon button next to a 32px button
needed its own popover offset to look right, which is a rule that exists only
because the heights disagreed.

Layout heights are not on this ladder and keep their own values: table rows
and header rows (44/48px), sidebar nav items (44px), the floating field
(52px), and the full-page spinner (80px). The ladder governs controls that can
stand next to each other in a toolbar, a form, or a table row.

## Type scale

Ten sizes exist and nothing between them, declared as `--text-*` in
`apps/web/app/globals.css`: `text-2xs` (11.5px), `text-xs` (12.5px), `text-sm`
(13px), `text-base` (13.5px), `text-md` (14px), `text-lg` (16px), `text-xl`
(17px), `text-2xl` (24px), `text-3xl` (26px), `text-4xl` (42px). Tailwind's
defaults are cleared, so `text-sm` is 13px here and not 14, and no step
carries a line-height: `normal` stays the default and prose opts in with
`leading-*`, as the body rule in `globals.css` explains.

An arbitrary size — `text-[13px]`, `text-[14.5px]`, any of them — is never
correct, including when it matches a step. The app drew twenty-six sizes from
what its primitives describe as seven, ten of them between 11 and 16 pixels,
which is how the same card heading came to be 15, 16 and 17. Pick the step;
if none of the ten fits, the change is to the scale, not to the call site.

Each step has a job: `2xs` chips, badges and menu group labels; `xs` help
text and meta; `sm` controls — buttons, labels, tabs; `base` body — table
cells, dialog copy, nav; `md` field text and list titles; `lg` card headings,
and the 16px floor that keeps iOS from zooming a focused field; `xl` dialog
titles and section headings; `2xl` page titles; `3xl` metric numerals; `4xl`
the hero numeral. The Nutrition Facts label keeps its own sizes because it
imitates a regulated format, the way table rows sit outside the control
height ladder. `apps/web/tests/type-scale-pins.test.ts` refuses any other size.

## Dialog width

Five steps, set with `size` on `DialogContent`: `sm` (470px, the default),
`md` (560px), `lg` (760px), `xl` (1000px), `full` (1360px). `xl` exists for a
dialog that puts two panes side by side; `full` is the reviewer that puts a
document beside its fields, where the document has to stay readable at the same
time as the lines read from it. A width in `className` is never correct; if
none of the five fits, the change is to `DIALOG_SIZES`. Height is not a width:
a dialog that owns the viewport sets `flex h-[calc(100dvh-2rem)] flex-col` in
`className`, the same way the components picker sets its own height.

## Migrations

A migration either changes schema or writes rows, never both: one that writes
rows is named `NNNN_backfill_*`, `NNNN_fix_*` or `NNNN_delete_*` and carries no
schema operation, because PostgreSQL refuses an `ALTER TABLE` that follows a
data pass in the same transaction. A destructive change ships in two releases —
state-only removal first, the database drop next — so the running code never
meets a column it still selects. `atomic = False` is acceptable only when every
operation in the file is idempotent; otherwise split the migration, because a
failure part-way through commits what ran and a retry then fails.

## Tests

A read endpoint that assembles a tenant-wide snapshot pins its query count with
`self.assertNumQueries(n, msg=...)`, where the message says what regression the
number is guarding; a bulk write asserts instead that the count does not grow
with the input, because statement batching is database-specific. When a pinned
count changes, the pull request says which query was added or removed and why it
cannot be avoided. An external effect — mail, an HTTP call, a worker enqueue —
runs outside the transaction that records it.

## Branch workflow and cleanup

- `main` is the only long-lived branch. Create temporary feature branches from
  the current `main`, target their pull requests directly at `main`, and use a
  merge commit so the feature branch remains an ancestor of the result.
- Before deleting a temporary branch, confirm its pull request is merged or
  intentionally closed, its worktree is clean, and every commit is reachable
  from `main`. Remove any linked worktree before deleting the local branch,
  then delete the remote branch and prune remote-tracking refs.
- After merging, fast-forward local `main` to `origin/main`, verify the merged
  feature tip is reachable from it, and remove the temporary branch before
  reporting the repository clean.
- A worktree under `.claude/worktrees/` shares the main checkout's
  `node_modules` and `apps/api/.venv` through symlinks. Never run `pnpm add`
  or `pnpm install` inside one: pnpm rewrites every `.bin` shim relative to
  the worktree and the main checkout's `tsc`, `eslint`, `vitest` and
  `prettier` stop resolving. A change that needs a new dependency installs a
  real `node_modules` in its worktree first.

## Code Review Rules

### Finding threshold

- Report substantiated P0/P1 defects introduced by the change as blocking: issues that can cause incorrect user-visible behavior, data loss or corruption, a security or privacy failure, an authorization bypass, a broken external contract, or a material production regression. Report concrete P2 defects as non-blocking follow-ups and require a linked issue before resolving the review thread. Do not report style, naming, formatting, optional refactors, minor UX preferences, or speculative hardening as findings. Leave deterministic checks to CI.
- Every finding must identify the concrete failure scenario, the affected changed code, and why existing tests or guards do not prevent it. If the impact depends on an unverified assumption, investigate it before reporting; omit the finding if it cannot be substantiated.
- Do not report theoretical edge cases. A scenario counts as real only if its triggering input or state can be produced through an actual entry point: the UI, the HTTP surface in `docs/CONTRACT.md`, an importer, or a scheduled job. Findings framed as "if this were ever called with...", "an attacker could in principle...", or "should X ever change..." are not findings unless that path is traced and shown reachable today. When reachability cannot be demonstrated, drop the finding entirely rather than reporting it as a caveat, nit, or "worth noting".
- Prefer a short review with zero findings over a padded one. Absence of findings is a valid and complete review result; do not add commentary, praise, summaries of the diff, or defensive suggestions to fill space.

### Tenant and private-data boundaries

- Reject any change that commits production catalogs, prices, recipes, invoices, sales exports, customer data, credentials, or other private operational data. Treat object identifiers as untrusted input: every read or write of user-owned data must be scoped to the authenticated user or tenant; an object ID alone is never authorization.
  Safe path: use synthetic fixtures and authorize through a user- or tenant-scoped queryset before reading or mutating an object.

### Sales accounting

- Preserve provider and channel identity in sales imports, and prevent revenue from being counted twice. Bundle and modifier attribution is a product view of the same net revenue, not additional sales.
  Safe path: a bundle is a product whose components include other products. Every sale line attaches to one variant and one product; that product's as-sold revenue is immutable and reconciles to the channel. An expanded view moves a bundle's money to the products inside it by relative standalone value — price, else cost, else count, chosen per bundle level — splitting all five money fields with the same integer, sign-aware, conserving allocation, recursively. Units are per product and are never summed across products. A variant may claim less than the whole sale through its attribution percent, in which case the remainder is reported as unattributed and reaches no product; it must never be redistributed to the products the variant does name. Any one table shows one view.
