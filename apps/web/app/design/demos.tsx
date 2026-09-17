import type * as React from "react"

import { SECTIONS_A } from "./sections-a"
import { SECTIONS_B } from "./sections-b"

/**
 * The guide's registry: every section, in the owner's order, and the
 * contents rail built from it.
 *
 * One section is a heading anchor and the `Demo` that lays the component out
 * on the page: every variant and size it has, in a `Matrix` or a `Row` from
 * matrix.tsx, and no prose. The halves live in `sections-a.tsx` and
 * `sections-b.tsx` only because the list is long; both are server modules, so
 * `page.tsx` can map over what they export, while the demo bodies they name
 * sit in their `"use client"` siblings.
 *
 * This file is also where every new `components/ui` primitive becomes
 * reachable: the demos import card, chip, toggle, avatar, thumbnail, number
 * field, radio group, popover, scroll area, colour field and picker and drop
 * zone, so the page is the one importer they all have.
 */
export type GuideSection = {
  id: string
  title: string
  Demo: React.ComponentType
}

export const SECTIONS: GuideSection[] = [...SECTIONS_A, ...SECTIONS_B]

/**
 * The contents rail: one link per section, then the tokens, which are page
 * content rather than a component and so have no entry of their own.
 */
export const CONTENTS: { id: string; title: string }[] = [
  ...SECTIONS.map(({ id, title }) => ({ id, title })),
  { id: "design-tokens", title: "Design tokens" },
]
