"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MonthGrid, addMonths } from "@/components/ui/month-grid"
import {
  addDays,
  dateKey,
  localDateKey,
  parseDateKey,
  startOfMonth,
  type DatePreset,
} from "@/lib/date-presets"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { formatCalendarDate, formatMonthYear } from "@/lib/datetime"
import { cn } from "@/lib/utils"

/** The longest range the forecast will plan, matching the backend's limit. */
export const MAX_FORECAST_DAYS = 92

/** The dates a kitchen plans for: from today forward, never back. */
export function forecastPresets(today: string): DatePreset[] {
  const weekday = parseDateKey(today).getUTCDay()
  const nextMonday = addDays(
    today,
    ((8 - weekday) % 7) + (weekday === 1 ? 7 : 0)
  )
  return [
    { id: "today", label: "Today", startDate: today, endDate: today },
    {
      id: "tomorrow",
      label: "Tomorrow",
      startDate: addDays(today, 1),
      endDate: addDays(today, 1),
    },
    {
      id: "next_7_days",
      label: "Next 7 days",
      startDate: today,
      endDate: addDays(today, 6),
    },
    {
      id: "next_week",
      label: "Next week",
      startDate: nextMonday,
      endDate: addDays(nextMonday, 6),
    },
    {
      id: "next_14_days",
      label: "Next 14 days",
      startDate: today,
      endDate: addDays(today, 13),
    },
    {
      id: "next_30_days",
      label: "Next 30 days",
      startDate: today,
      endDate: addDays(today, 29),
    },
  ]
}

/** The spoken form, for the trigger's label. */
function formatDateRange(startDate: string, endDate: string) {
  if (startDate === endDate) return formatCalendarDate(startDate)
  return `${formatCalendarDate(startDate)} – ${formatCalendarDate(endDate)}`
}

/**
 * The forecast's date picker: the same calendar as the reporting-period
 * filter, turned to face forward. Today and the future are open, the past is
 * not, and a first click starts a range that a second click applies. A range
 * longer than the forecast will plan is cut at the limit rather than refused.
 */
export function ForecastDateFilter({
  selectedStartDate,
  selectedEndDate,
  timeZone,
  onSelectedDateRangeChange,
  pending = false,
  className,
}: {
  selectedStartDate: string
  selectedEndDate: string
  timeZone: string
  onSelectedDateRangeChange: (startDate: string, endDate: string) => void
  /** True while the range just picked is still on its way to the screen. */
  pending?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [pendingStartDate, setPendingStartDate] = React.useState<string | null>(
    null
  )
  const [hoveredDate, setHoveredDate] = React.useState<string | null>(null)
  const today = localDateKey(timeZone)
  const [calendarMonth, setCalendarMonth] = React.useState(() =>
    startOfMonth(parseDateKey(selectedStartDate))
  )
  const previewEndDate =
    pendingStartDate && hoveredDate && hoveredDate >= pendingStartDate
      ? hoveredDate
      : null
  const displayedRangeStart = pendingStartDate ?? selectedStartDate
  const displayedRangeEnd = pendingStartDate
    ? (previewEndDate ?? pendingStartDate)
    : selectedEndDate
  const nextMonth = addMonths(calendarMonth, 1)
  const todayMonth = startOfMonth(parseDateKey(today))
  const atEarliestMonth = calendarMonth <= todayMonth
  const presets = forecastPresets(today)
  const activePreset = presets.find(
    (preset) =>
      preset.startDate === selectedStartDate &&
      preset.endDate === selectedEndDate
  )
  const pillValue =
    activePreset?.label ??
    formatDateRangeLabel(selectedStartDate, selectedEndDate)
  const latestEnd = pendingStartDate
    ? addDays(pendingStartDate, MAX_FORECAST_DAYS - 1)
    : null

  const reset = () => {
    setPendingStartDate(null)
    setHoveredDate(null)
  }

  const choosePreset = (preset: DatePreset) => {
    setOpen(false)
    reset()
    onSelectedDateRangeChange(preset.startDate, preset.endDate)
  }

  const chooseCalendarDate = (date: string) => {
    if (!pendingStartDate || date < pendingStartDate) {
      setPendingStartDate(date)
      setHoveredDate(null)
      return
    }
    const startDate = pendingStartDate
    const endDate = latestEnd && date > latestEnd ? latestEnd : date
    setOpen(false)
    reset()
    onSelectedDateRangeChange(startDate, endDate)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          reset()
          setCalendarMonth(startOfMonth(parseDateKey(selectedStartDate)))
        }
      }}
    >
      <Popover.Trigger
        render={
          <Button
            variant="filter"
            className={cn("shrink-0 gap-1.5", className)}
            pending={pending}
            aria-label={`Dates: ${formatDateRange(selectedStartDate, selectedEndDate)}`}
          />
        }
      >
        Dates
        <span className="font-medium text-foreground">{pillValue}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="max-h-[calc(100dvh-2rem)] w-[min(47rem,calc(100vw-2rem))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
            <Popover.Title className="sr-only">
              Choose dates to plan for
            </Popover.Title>
            <div className="grid sm:grid-cols-[10rem_minmax(0,1fr)]">
              <div className="flex flex-col gap-1 border-b border-popover-border pb-3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
                {presets.map((preset) => (
                  <Button
                    key={preset.id}
                    variant="quiet"
                    className={cn(
                      "justify-start",
                      activePreset?.id === preset.id &&
                        !pendingStartDate &&
                        "bg-muted text-foreground"
                    )}
                    aria-pressed={
                      activePreset?.id === preset.id && !pendingStartDate
                    }
                    onClick={() => choosePreset(preset)}
                  >
                    {preset.label}
                  </Button>
                ))}
                <p className="mt-2 border-t border-popover-border pt-2 text-xs text-muted-foreground">
                  Or pick a first and a last day on the calendar, up to{" "}
                  {MAX_FORECAST_DAYS} days.
                </p>
              </div>
              <div className="grid pt-3 sm:pt-0 sm:pl-5 md:grid-cols-2">
                {[calendarMonth, nextMonth].map((month, monthIndex) => {
                  const isLeadingMonth = monthIndex === 0
                  return (
                    <div
                      key={dateKey(month)}
                      className={
                        isLeadingMonth
                          ? "md:pr-5"
                          : "hidden md:block md:border-l md:border-popover-border md:pl-5"
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        {isLeadingMonth ? (
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label="Previous month"
                            disabled={atEarliestMonth}
                            onClick={() =>
                              setCalendarMonth((current) =>
                                addMonths(current, -1)
                              )
                            }
                          >
                            <ChevronLeft />
                          </Button>
                        ) : (
                          <span className="size-7" />
                        )}
                        <p className="text-md font-semibold">
                          {formatMonthYear(month)}
                        </p>
                        {isLeadingMonth ? (
                          <>
                            <span className="hidden size-7 md:block" />
                            <Button
                              variant="quiet"
                              size="icon-sm"
                              aria-label="Next month"
                              className="md:hidden"
                              onClick={() => setCalendarMonth(nextMonth)}
                            >
                              <ChevronRight />
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label="Next month"
                            onClick={() => setCalendarMonth(nextMonth)}
                          >
                            <ChevronRight />
                          </Button>
                        )}
                      </div>
                      <MonthGrid
                        month={month}
                        today={today}
                        onSelectDate={chooseCalendarDate}
                        onHoverDate={(date) => {
                          if (!date || pendingStartDate) setHoveredDate(date)
                        }}
                        decorate={(key) => {
                          const isRangeStart = key === displayedRangeStart
                          const isRangeEnd = key === displayedRangeEnd
                          const inRange =
                            key > displayedRangeStart && key < displayedRangeEnd
                          const soft =
                            Boolean(pendingStartDate) &&
                            key === previewEndDate &&
                            key !== pendingStartDate
                          const isCommittedEnd = !pendingStartDate && isRangeEnd
                          const selected = isRangeStart || isCommittedEnd
                          const multiDay =
                            displayedRangeStart !== displayedRangeEnd
                          return {
                            selected,
                            inRange,
                            soft,
                            edge: multiDay
                              ? isRangeStart
                                ? "start"
                                : isCommittedEnd
                                  ? "end"
                                  : null
                              : null,
                            disabled:
                              key < today ||
                              (latestEnd !== null && key > latestEnd),
                            pressed:
                              key === pendingStartDate ||
                              (!pendingStartDate && (selected || inRange)),
                          }
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
