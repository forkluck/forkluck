"use client"

import * as React from "react"
import Link from "next/link"
import {
  Cell,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import type { MenuItemRow } from "@/lib/backend/types"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import {
  MENU_CLASS_LABELS,
  deriveRows,
  type MenuClass,
} from "@/lib/menu/engineering"
import { formatCents, quantityFormat } from "@/lib/money"
import { productHref } from "@/lib/product-href"

const CLASSES: readonly MenuClass[] = ["star", "plowhorse", "puzzle", "dog"]

// Green, blue, amber, red: the two oranges this used to carry were 5 ΔE
// apart, which no eye separates at dot size. Blue is chart-mark colour by
// the app's own rule, so the plowhorse takes it.
const CLASS_COLORS: Record<MenuClass, string> = {
  star: "var(--color-success)",
  plowhorse: "var(--color-brand)",
  puzzle: "var(--color-warning)",
  dog: "var(--color-destructive)",
}

const chartConfig = Object.fromEntries(
  CLASSES.map((name) => [
    name,
    { label: MENU_CLASS_LABELS[name], color: CLASS_COLORS[name] },
  ])
) satisfies ChartConfig

/**
 * Breathing room at each end, so an extreme dot never kisses the border. The
 * vertical band is deeper so a dot in a corner clears the quadrant's name.
 */
const PAD_X = 0.06
const PAD_Y = 0.1

/**
 * Half the plot per side of the threshold, so the two dashed lines cross at
 * the middle and the quadrants read equal — one $32 outlier would otherwise
 * squash the rest into a corner. Piecewise, which is why the axes carry no
 * tick values: only the two thresholds are readable positions.
 */
export function matrixAxis(
  threshold: number,
  min: number,
  max: number,
  pad = PAD_X
): (value: number) => number {
  const lowSpan = Math.max(threshold - Math.min(0, min), Number.EPSILON)
  const highSpan = Math.max(max - threshold, Number.EPSILON)
  return (value) => {
    const half =
      value <= threshold
        ? (0.5 * (value - (threshold - lowSpan))) / lowSpan
        : 0.5 + (0.5 * (value - threshold)) / highSpan
    return pad + half * (1 - 2 * pad)
  }
}

export type MatrixPoint = {
  key: string
  name: string
  href: string | null
  marginCents: number
  qtySold: number
  grossProfitCents: number
  class: MenuClass
  /** Plot position, 0..1, with the thresholds at 0.5. */
  x: number
  y: number
}

function itemHref(item: MenuItemRow): string | null {
  if (item.recipePublicId)
    return `/recipes/${encodeURIComponent(item.recipePublicId)}/recipe`
  if (item.productPublicId)
    return productHref({ publicId: item.productPublicId })
  return null
}

/**
 * The worksheet's own arithmetic, run over every row so the thresholds match
 * the Class column exactly; only classified rows become dots.
 */
export function menuMatrixPoints(items: readonly MenuItemRow[]): {
  points: MatrixPoint[]
  averageMarginDollars: number
  popularityThreshold: number
  /** Rows with no food cost yet, so no margin and no dot. */
  uncosted: MenuItemRow[]
} {
  const figures = items.map((item) => ({
    sellPriceCents: item.sellPriceCents,
    // A product row's quantity is what sales say, as on the worksheet.
    qtySold: item.productId ? (item.sourceQtySold ?? 0) : item.qtySold,
    foodCostCents: item.foodCostCents,
  }))
  const { rows, summary } = deriveRows(figures)
  const averageMarginDollars = summary.averageMarginCents / 100
  // The inverse of the 70% rule: the quantity a row needs to count popular.
  const popularityThreshold =
    items.length > 0 ? (7 * summary.quantity) / (items.length * 10) : 0

  const classified = rows.flatMap((row, index) =>
    row.class !== null && row.marginCents !== null
      ? [
          {
            item: items[index],
            marginDollars: row.marginCents / 100,
            marginCents: row.marginCents,
            grossProfitCents: row.grossProfitCents ?? 0,
            qtySold: figures[index].qtySold,
            class: row.class,
          },
        ]
      : []
  )
  const uncosted = rows.flatMap((row, index) =>
    row.class === null || row.marginCents === null ? [items[index]] : []
  )

  const margins = classified.map((row) => row.marginDollars)
  const quantities = classified.map((row) => row.qtySold)
  const scaleX = matrixAxis(
    averageMarginDollars,
    Math.min(averageMarginDollars, ...margins),
    Math.max(averageMarginDollars, ...margins)
  )
  const scaleY = matrixAxis(
    popularityThreshold,
    Math.min(popularityThreshold, ...quantities),
    Math.max(popularityThreshold, ...quantities),
    PAD_Y
  )

  const points = classified.map((row) => ({
    key: row.item.id,
    name: row.item.name,
    href: itemHref(row.item),
    marginCents: row.marginCents,
    qtySold: row.qtySold,
    grossProfitCents: row.grossProfitCents,
    class: row.class,
    x: scaleX(row.marginDollars),
    y: scaleY(row.qtySold),
  }))
  return { points, averageMarginDollars, popularityThreshold, uncosted }
}

function MatrixTooltip({
  active,
  payload,
  currencyCode,
}: {
  active?: boolean
  payload?: Array<{ payload?: MatrixPoint }>
  currencyCode: string
}) {
  const point = active ? payload?.[0]?.payload : undefined
  if (!point) return null
  return (
    <div className="grid min-w-40 gap-1 rounded-lg border border-border/50 bg-card px-2.5 py-1.5 text-xs leading-4 shadow-xl">
      <div className="font-medium">{point.name}</div>
      {[
        ["Class", MENU_CLASS_LABELS[point.class]],
        ["Margin", formatCents(point.marginCents, currencyCode)],
        ["Units sold", quantityFormat.format(point.qtySold)],
        ["Gross profit", formatCents(point.grossProfitCents, currencyCode)],
      ].map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 leading-none">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  )
}

const CLASS_ORDER = Object.fromEntries(CLASSES.map((name, i) => [name, i]))

/** The Kasavana–Smith matrix: margin dollars across, units sold up. */
export function MenuMatrix({
  items,
  currencyCode,
  periodStart = null,
  periodEnd = null,
}: {
  items: readonly MenuItemRow[]
  currencyCode: string
  periodStart?: string | null
  periodEnd?: string | null
}) {
  const { points, averageMarginDollars, popularityThreshold, uncosted } =
    React.useMemo(() => menuMatrixPoints(items), [items])

  // Stars first, then what the operator should act on; the biggest earner
  // leads each class.
  const rows = React.useMemo(
    () =>
      [...points].sort(
        (a, b) =>
          CLASS_ORDER[a.class] - CLASS_ORDER[b.class] ||
          b.grossProfitCents - a.grossProfitCents
      ),
    [points]
  )

  if (!points.length) {
    return (
      <p className="text-base text-muted-foreground">
        Nothing to plot yet. Link menu items to a costed recipe or product and
        the matrix fills in.
      </p>
    )
  }

  const period =
    periodStart && periodEnd
      ? formatDateRangeLabel(periodStart, periodEnd)
      : "All time"

  const nameCell = (name: string, href: string | null) =>
    href ? (
      <Link href={href} className="hover:underline">
        {name}
      </Link>
    ) : (
      name
    )

  // Wider than ~860px the dots drift apart into a sparse field.
  return (
    <section className="max-w-[860px]">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {CLASSES.map((name) => (
          <div
            key={name}
            className="flex items-center gap-1.5 text-base text-muted-foreground"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: CLASS_COLORS[name] }}
            />
            <span className="text-foreground">
              {MENU_CLASS_LABELS[name] + "s"}
            </span>
            <span className="tabular-nums">
              {points.filter((point) => point.class === name).length}
            </span>
          </div>
        ))}
        <span className="ml-auto text-base text-muted-foreground">
          {period}
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        <div className="flex w-4 shrink-0 flex-col items-center justify-between py-2 text-2xs text-faint">
          <span>High</span>
          <span className="rotate-180" style={{ writingMode: "vertical-rl" }}>
            Units sold
          </span>
          {/* The x row's Low at the origin speaks for both axes. */}
          <span aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-[300px] w-full border-b border-l border-border">
            {/* Quadrant names and threshold labels: under the chart, so the
                tooltip covers them. */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden text-2xs text-faint">
              <span className="absolute top-2 left-2">Plowhorses</span>
              <span className="absolute top-2 right-2">Stars</span>
              <span className="absolute bottom-2 left-2">Dogs</span>
              <span className="absolute right-2 bottom-2">Puzzles</span>
              <span className="absolute top-1/2 left-2 -translate-y-[calc(100%+5px)]">
                {`Popularity threshold ${quantityFormat.format(popularityThreshold)} units`}
              </span>
            </div>
            <ChartContainer
              config={chartConfig}
              // The size a chart drawn before it is measured uses: a tab
              // painted in the background never gets its first resize.
              initialDimension={{ width: 860, height: 300 }}
              className="absolute inset-0 aspect-auto h-full w-full"
            >
              <ScatterChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <XAxis type="number" dataKey="x" domain={[0, 1]} hide />
                <YAxis type="number" dataKey="y" domain={[0, 1]} hide />
                <ReferenceLine
                  x={0.5}
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                />
                <ReferenceLine
                  y={0.5}
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                />
                <Tooltip
                  cursor={false}
                  isAnimationActive={false}
                  content={<MatrixTooltip currencyCode={currencyCode} />}
                />
                <Scatter data={points} isAnimationActive={false}>
                  {points.map((point) => (
                    <Cell key={point.key} fill={CLASS_COLORS[point.class]} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ChartContainer>
          </div>

          <div className="mt-1.5 flex justify-between text-2xs text-faint">
            <span>Low</span>
            <span>
              {`Margin per item · avg ${formatCents(averageMarginDollars * 100, currencyCode)}`}
            </span>
            <span>High</span>
          </div>
        </div>
      </div>

      {/* The dots, as a list: which item is which, and what to do about it. */}
      <TableFrame className="mt-6 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead className="min-w-48">Item</TableHead>
              <TableHead className="min-w-28">Class</TableHead>
              <TableHead className="min-w-24 text-right">Units sold</TableHead>
              <TableHead className="min-w-24 text-right">Margin</TableHead>
              <TableHead className="min-w-28 text-right">
                Gross profit
              </TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.map((point) => (
              <TableRow key={point.key}>
                <TableCell>{nameCell(point.name, point.href)}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: CLASS_COLORS[point.class] }}
                    />
                    {MENU_CLASS_LABELS[point.class]}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {quantityFormat.format(point.qtySold)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(point.marginCents, currencyCode)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(point.grossProfitCents, currencyCode)}
                </TableCell>
              </TableRow>
            ))}
            {uncosted.map((item) => (
              <TableRow key={item.id} className="text-muted-foreground">
                <TableCell>{nameCell(item.name, itemHref(item))}</TableCell>
                <TableCell>No food cost yet</TableCell>
                <TableCell className="text-right tabular-nums">
                  {quantityFormat.format(
                    item.productId ? (item.sourceQtySold ?? 0) : item.qtySold
                  )}
                </TableCell>
                <TableCell className="text-right">–</TableCell>
                <TableCell className="text-right">–</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}
