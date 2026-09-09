import type { MenuForecast } from "@/lib/backend/types"
import { csvCell } from "@/lib/csv"
import { unitShort } from "@/lib/unit-registry"

import { makes, packsToBuy } from "@/components/menus/forecast-format"

/**
 * The two lists a kitchen takes away from a forecast: what to buy and what to
 * make. Plain numbers in the backend's own units, so a spreadsheet can add
 * them; the screen's kg-or-lb restatement stays on the screen.
 */

const SHOPPING_HEADER = [
  "Material",
  "Kind",
  "Needed",
  "Unit",
  "Packs to buy",
  "Pack size",
  "Pack unit",
  "Supplier pack",
  "Cost",
]

const PREP_HEADER = ["Recipe", "Batches", "Makes", "Unit"]

const money = (cents: number | null) =>
  cents === null ? "" : (cents / 100).toFixed(2)

const number = (value: number | null) =>
  value === null ? "" : String(Math.round(value * 1000) / 1000)

export function shoppingListRow(
  row: MenuForecast["materialRequirements"][number]
): string {
  const purchase = row.purchase[0] ?? null
  // Without a purchase figure the recipe side is all there is, in whatever
  // units the recipes used; the cell then carries its own units.
  const needed = purchase
    ? number(purchase.quantity)
    : row.usage
        .map(
          (line) =>
            `${number(line.quantity)} ${unitShort(line.unit) || line.unit}`
        )
        .join("; ")
  return [
    csvCell(row.ingredientName, { alwaysQuote: true }),
    row.kind,
    csvCell(needed),
    purchase ? csvCell(unitShort(purchase.unit) || purchase.unit) : "",
    number(packsToBuy(row.packs)),
    number(row.purchaseSize),
    row.purchaseUnit
      ? csvCell(unitShort(row.purchaseUnit) || row.purchaseUnit)
      : "",
    row.supplierPack
      ? csvCell(`${row.supplierPack.supplier}: ${row.supplierPack.rawSize}`, {
          alwaysQuote: true,
        })
      : "",
    money(row.costCents),
  ].join(",")
}

export function prepListRow(
  row: MenuForecast["recipeRequirements"][number]
): string {
  const made = makes(row)
  return [
    csvCell(row.recipeTitle, { alwaysQuote: true }),
    number(row.batches),
    made ? number(made.quantity) : "",
    made ? csvCell(unitShort(made.unit) || made.unit) : "",
  ].join(",")
}

export function shoppingListCsv(forecast: MenuForecast): string {
  return [
    SHOPPING_HEADER.join(","),
    ...forecast.materialRequirements.map(shoppingListRow),
  ].join("\n")
}

export function prepListCsv(forecast: MenuForecast): string {
  return [
    PREP_HEADER.join(","),
    ...forecast.recipeRequirements.map(prepListRow),
  ].join("\n")
}

/** `mnu_spring-shopping-list-2026-04-27.csv`: the menu and the day it starts. */
export function exportFileName(
  forecast: MenuForecast,
  list: "shopping-list" | "prep-list"
) {
  return `${forecast.menu.publicId}-${list}-${forecast.basis.horizonStart}.csv`
}

/** Client-side download of one CSV text. */
export function downloadCsv(text: string, fileName: string) {
  const blob = new Blob([text], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
