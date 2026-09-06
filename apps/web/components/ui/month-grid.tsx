"use client"

import * as React from "react"

import { dateKey, parseDateKey, startOfMonth } from "@/lib/date-presets"

export const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

const weekdayLabels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]

export function addMonths(value: Date, amount: number) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1)
  )
}

export function formatDay(date: string) {
  return dayFormat.format(new Date(`${date}T12:00:00Z`))
}

function daysInMonth(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)
  ).getUTCDate()
}

/** One month as a flat cell list, `null` for the days before the first. */
export function monthCells(month: Date) {
  const leadingEmptyDays = startOfMonth(month).getUTCDay()
  return Array.from(
    { length: leadingEmptyDays + daysInMonth(month) },
    (_, index) =>
      index < leadingEmptyDays
        ? null
        : new Date(
            Date.UTC(
              month.getUTCFullYear(),
              month.getUTCMonth(),
              index - leadingEmptyDays + 1
            )
          )
  )
}

/** How one day reads. A single-date picker only ever sets `selected`. */
export type DayDecoration = {
  /** The filled ink circle. */
  selected?: boolean
  /** Pale fill across the whole cell, for a day inside a range. */
  inRange?: boolean
  /** Pale half fill joining this day to the next or previous one. */
  edge?: "start" | "end" | null
  /** Pale circle, for a range end being previewed rather than committed. */
  soft?: boolean
  disabled?: boolean
  pressed?: boolean
}

/**
 * One month of days: the Su–Sa header over a seven-column grid, a filled
 * circle on the selected day and a ring on today. Shared by the single-date
 * field and the reporting-period range picker, which decorates the same cells
 * with its range fills.
 */
export function MonthGrid({
  month,
  today,
  decorate,
  onSelectDate,
  onHoverDate,
}: {
  month: Date
  /** Today's date key in the surface's timezone; rings that cell. */
  today: string
  decorate?: (date: string) => DayDecoration
  onSelectDate: (date: string) => void
  /** Called on hover and focus, for a range picker's preview. */
  onHoverDate?: (date: string | null) => void
}) {
  return (
    <>
      <div className="mt-4 grid grid-cols-7 text-center text-xs leading-4 font-medium text-muted-foreground">
        {weekdayLabels.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div
        className="mt-2 grid grid-cols-7 gap-y-1"
        onMouseLeave={() => onHoverDate?.(null)}
      >
        {monthCells(month).map((day, index) => {
          if (!day) return <span key={`empty-${index}`} />
          const key = dateKey(day)
          const {
            selected = false,
            inRange = false,
            edge = null,
            soft = false,
            disabled = false,
            pressed = selected,
          } = decorate?.(key) ?? {}
          const isToday = key === today
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              aria-label={formatDay(key)}
              aria-pressed={pressed}
              onClick={() => onSelectDate(key)}
              onFocus={() => onHoverDate?.(key)}
              onMouseEnter={() => onHoverDate?.(key)}
              className={`group relative flex h-9 w-full items-center justify-center text-md font-medium outline-none disabled:cursor-not-allowed disabled:text-disabled-foreground ${
                edge === "start"
                  ? "after:absolute after:inset-y-0 after:right-0 after:w-1/2 after:bg-muted"
                  : soft || edge === "end"
                    ? "before:absolute before:inset-y-0 before:left-0 before:w-1/2 before:bg-muted"
                    : inRange
                      ? "bg-muted"
                      : ""
              }`}
            >
              <span
                className={`relative z-10 flex size-9 items-center justify-center rounded-full border border-transparent group-focus-visible:border-foreground ${
                  selected
                    ? "bg-foreground text-background"
                    : soft
                      ? "bg-muted"
                      : isToday
                        ? "border-foreground group-hover:bg-muted"
                        : inRange
                          ? ""
                          : "group-hover:bg-muted"
                }`}
              >
                {day.getUTCDate()}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/** The month a picker opens on: the value's own month, or today's. */
export function openingMonth(value: string, today: string) {
  return startOfMonth(
    parseDateKey(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today)
  )
}
