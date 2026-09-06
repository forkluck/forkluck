// Menu engineering: the Kasavana–Smith matrix over one worksheet. Margin
// dollars against popularity, never food-cost percent.

export type MenuClass = "star" | "plowhorse" | "puzzle" | "dog"

export const MENU_CLASS_LABELS: Record<MenuClass, string> = {
  star: "Star",
  plowhorse: "Plowhorse",
  puzzle: "Puzzle",
  dog: "Dog",
}

/** What one row contributes; `foodCostCents` is null when it is uncosted. */
export type MenuFigures = {
  sellPriceCents: number
  qtySold: number
  foodCostCents: number | null
}

export type DerivedRow = {
  revenueCents: number
  marginCents: number | null
  grossProfitCents: number | null
  foodCostPercent: number | null
  percentOfSales: number | null
  menuMix: number | null
  class: MenuClass | null
}

export type MenuSummary = {
  revenueCents: number
  costCents: number
  profitCents: number
  menuCostPercent: number | null
  quantity: number
  uncostedCount: number
  averageMarginCents: number
}

export function summarize(rows: readonly MenuFigures[]): MenuSummary {
  let revenueCents = 0
  let costCents = 0
  let profitCents = 0
  let quantity = 0
  let costedQuantity = 0
  let uncostedCount = 0

  for (const row of rows) {
    revenueCents += Math.round(row.sellPriceCents * row.qtySold)
    quantity += row.qtySold
    if (row.foodCostCents === null) {
      uncostedCount += 1
      continue
    }
    costCents += Math.round(row.foodCostCents * row.qtySold)
    profitCents += Math.round(
      (row.sellPriceCents - row.foodCostCents) * row.qtySold
    )
    costedQuantity += row.qtySold
  }

  return {
    revenueCents,
    costCents,
    profitCents,
    menuCostPercent: revenueCents === 0 ? null : costCents / revenueCents,
    quantity,
    uncostedCount,
    averageMarginCents: costedQuantity > 0 ? profitCents / costedQuantity : 0,
  }
}

function quadrant(popular: boolean, profitable: boolean): MenuClass {
  if (popular) return profitable ? "star" : "plowhorse"
  return profitable ? "puzzle" : "dog"
}

export function deriveRows(rows: readonly MenuFigures[]): {
  rows: DerivedRow[]
  summary: MenuSummary
} {
  const summary = summarize(rows)
  const count = rows.length
  const classify = count > 0 && summary.quantity > 0

  const derived = rows.map((row) => {
    const foodCostCents = row.foodCostCents
    const revenueCents = Math.round(row.sellPriceCents * row.qtySold)
    const marginCents =
      foodCostCents === null ? null : row.sellPriceCents - foodCostCents
    const grossProfitCents =
      marginCents === null ? null : Math.round(marginCents * row.qtySold)
    // Integer form: 0.7 * 100 is not 70 in floating point.
    const popular = row.qtySold * count * 10 >= 7 * summary.quantity

    return {
      revenueCents,
      marginCents,
      grossProfitCents,
      foodCostPercent:
        foodCostCents !== null && row.sellPriceCents > 0
          ? foodCostCents / row.sellPriceCents
          : null,
      percentOfSales:
        summary.revenueCents === 0 ? null : revenueCents / summary.revenueCents,
      menuMix: summary.quantity === 0 ? null : row.qtySold / summary.quantity,
      class:
        classify && marginCents !== null
          ? quadrant(popular, marginCents >= summary.averageMarginCents)
          : null,
    }
  })

  return { rows: derived, summary }
}

/** An unsaved row has no snapshot yet, so it shows zero variance. */
export function originalFigures(
  row: MenuFigures & { original: MenuFigures | null }
): MenuFigures {
  return (
    row.original ?? {
      sellPriceCents: row.sellPriceCents,
      qtySold: row.qtySold,
      foodCostCents: row.foodCostCents,
    }
  )
}
