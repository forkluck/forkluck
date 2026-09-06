# Component layers

The component system has four responsibility layers. These are architectural
boundaries over the existing files, not a reason to move working components or
change their rendered output.

| Layer          | Responsibility                                                                         | Current examples                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Primitives     | One control or visual atom. Owns tokens, variants, focus, and accessible HTML.         | `ui/button.tsx`, `ui/input.tsx`, `ui/label.tsx`, `ui/checkbox.tsx`, `ui/select.tsx`, `ui/separator.tsx`                |
| Components     | Small, reusable compositions with one UI meaning and no feature data access.           | `ui/card.tsx`, `ui/badge.tsx`, `ui/field.tsx`, `ui/filter-pill.tsx`, `ui/tab-pills.tsx`                                |
| Patterns       | Repeatable interaction or information arrangements composed from the two layers below. | `ui/data-table.tsx`, `ui/notice-banner.tsx`, `ui/metric-card.tsx`, `ui/date-range-filter.tsx`, `ui/confirm-dialog.tsx` |
| Page templates | Screen and application-shell structure. Owns layout rhythm, not feature behavior.      | `ui/page.tsx`, `app-shell.tsx`, `app-sidebar.tsx`, `main-header.tsx`                                                   |

Feature components live in folders such as `ingredients/`, `recipes/`, and
`sales/`. They may compose any design-system layer. Routes provide data and
Server Actions; design-system files do not import route actions or
`lib/backend`.

## Contribution contract

Imports flow downward: page templates → patterns → components → primitives.
A lower layer must not know about a higher layer or a feature folder. When a
piece is useful in more than one feature, promote the smallest stable UI
contract rather than moving feature data-fetching or mutation logic with it.

Keep visual decisions in the existing tokens and variants in `app/globals.css`
and `components/ui`. Add or update a component test for behavior and accessible
semantics; async Server Components and full user journeys belong in the
Playwright acceptance suite.
