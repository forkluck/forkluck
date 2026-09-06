"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  MonthGrid,
  addMonths,
  formatDay,
  monthFormat,
} from "@/components/ui/month-grid"
import {
  dateKey,
  datePresetGroups,
  formatPeriodCookie,
  localDateKey,
  parseDateKey,
  PERIOD_COOKIE,
  startOfMonth,
  type DatePreset,
} from "@/lib/date-presets"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { cn } from "@/lib/utils"

function anchorMonth(startDate: string, endDate: string, today: string) {
  const anchor = addMonths(startOfMonth(parseDateKey(endDate)), -1)
  const latest = addMonths(startOfMonth(parseDateKey(today)), -1)
  return anchor > latest ? latest : anchor
}

/** The spoken form, for the trigger's label. */
function formatDateRange(startDate: string, endDate: string) {
  if (startDate === endDate) return formatDay(startDate)
  return `${formatDay(startDate)} – ${formatDay(endDate)}`
}

const COOKIE_MAX_AGE_DAYS = 180

function rememberPeriod(id: string, timeZone: string) {
  document.cookie = `${PERIOD_COOKIE}=${encodeURIComponent(
    formatPeriodCookie(id, timeZone)
  )}; path=/; max-age=${COOKIE_MAX_AGE_DAYS * 86_400}; samesite=lax`
}

function forgetPeriod() {
  document.cookie = `${PERIOD_COOKIE}=; path=/; max-age=0; samesite=lax`
}

/**
 * The shared reporting-period picker used across the app.
 * A first calendar click starts a range; a second click applies it immediately.
 *
 * Passing `onClear` adds an "All time" choice and lets both dates be null,
 * which renders the pill as "All time" — for surfaces whose default is
 * unbounded (Products) rather than a preset period (Analytics, Labor).
 */
export function DateRangeFilter({
  selectedStartDate,
  selectedEndDate,
  timeZone,
  onSelectedDateRangeChange,
  onClear,
  pending = false,
  className,
}: {
  selectedStartDate: string | null
  selectedEndDate: string | null
  timeZone: string
  onSelectedDateRangeChange: (startDate: string, endDate: string) => void
  onClear?: () => void
  /** True while the range just picked is still on its way to the screen. */
  pending?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [pendingStartDate, setPendingStartDate] = React.useState<string | null>(
    null
  )
  const [draftRange, setDraftRange] = React.useState<{
    startDate: string
    endDate: string
  } | null>(null)
  const [hoveredDate, setHoveredDate] = React.useState<string | null>(null)
  const [customArmed, setCustomArmed] = React.useState(false)
  const today = localDateKey(timeZone)
  const [calendarMonth, setCalendarMonth] = React.useState(() =>
    anchorMonth(selectedStartDate ?? today, selectedEndDate ?? today, today)
  )
  // The "" sentinel is a date-key no calendar cell can equal, so an all-time
  // (null) selection simply highlights nothing.
  const visibleStartDate = draftRange?.startDate ?? selectedStartDate ?? ""
  const visibleEndDate = draftRange?.endDate ?? selectedEndDate ?? ""
  const previewEndDate =
    pendingStartDate && hoveredDate && hoveredDate >= pendingStartDate
      ? hoveredDate
      : null
  const displayedRangeStart = pendingStartDate ?? visibleStartDate
  const displayedRangeEnd = pendingStartDate
    ? (previewEndDate ?? pendingStartDate)
    : visibleEndDate
  const nextMonth = addMonths(calendarMonth, 1)
  const todayMonth = startOfMonth(parseDateKey(today))
  const atLatestMonth = nextMonth >= todayMonth
  const leadingAtLatestMonth = calendarMonth >= todayMonth
  const groups = datePresetGroups(today)
  const activePreset = groups
    .flat()
    .find(
      (preset) =>
        preset.startDate === visibleStartDate &&
        preset.endDate === visibleEndDate
    )
  const allTime = !visibleStartDate && !customArmed
  const activeLabel = allTime
    ? "All time"
    : customArmed || !activePreset
      ? "Custom range"
      : activePreset.label
  const selectedPreset = groups
    .flat()
    .find(
      (preset) =>
        preset.startDate === selectedStartDate &&
        preset.endDate === selectedEndDate
    )
  const pillValue =
    selectedStartDate && selectedEndDate
      ? (selectedPreset?.label ??
        formatDateRangeLabel(selectedStartDate, selectedEndDate))
      : "All time"

  // Only Overview and Labor read the period cookie. An all-time surface never
  // reads it, so it must not write it either.
  const sharesPeriod = !onClear

  const choosePreset = (preset: DatePreset) => {
    if (sharesPeriod) rememberPeriod(preset.id, timeZone)
    setOpen(false)
    setCustomArmed(false)
    setPendingStartDate(null)
    setDraftRange(null)
    setHoveredDate(null)
    onSelectedDateRangeChange(preset.startDate, preset.endDate)
  }

  const chooseCalendarDate = (date: string) => {
    if (!pendingStartDate) {
      setDraftRange(null)
      setPendingStartDate(date)
      setHoveredDate(null)
      return
    }

    if (date < pendingStartDate) {
      setPendingStartDate(date)
      setHoveredDate(null)
      return
    }

    const startDate = pendingStartDate
    const endDate = date
    if (sharesPeriod) forgetPeriod()
    setOpen(false)
    setCustomArmed(false)
    setPendingStartDate(null)
    setHoveredDate(null)
    setDraftRange({ startDate, endDate })
    onSelectedDateRangeChange(startDate, endDate)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setCustomArmed(false)
          setPendingStartDate(null)
          setDraftRange(null)
          setHoveredDate(null)
          setCalendarMonth(
            anchorMonth(
              selectedStartDate ?? today,
              selectedEndDate ?? today,
              today
            )
          )
        }
      }}
    >
      {/* The toolbar filter pill: quiet label, ink value, no chevron. */}
      <Popover.Trigger
        render={
          <Button
            variant="filter"
            className={cn("shrink-0 gap-1.5", className)}
            pending={pending}
            aria-label={`Date: ${
              selectedStartDate && selectedEndDate
                ? formatDateRange(selectedStartDate, selectedEndDate)
                : "All time"
            }`}
          />
        }
      >
        Date
        <span className="font-medium text-foreground">{pillValue}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="max-h-[calc(100dvh-2rem)] w-[min(47rem,calc(100vw-2rem))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
            <Popover.Title className="sr-only">Choose dates</Popover.Title>
            <div className="grid sm:grid-cols-[10rem_minmax(0,1fr)]">
              <div className="flex flex-col gap-1 border-b border-popover-border pb-3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
                {onClear ? (
                  <Button
                    variant="quiet"
                    className={cn(
                      "justify-start",
                      activeLabel === "All time" && "bg-muted text-foreground"
                    )}
                    aria-pressed={activeLabel === "All time"}
                    onClick={() => {
                      setOpen(false)
                      setCustomArmed(false)
                      setPendingStartDate(null)
                      setDraftRange(null)
                      setHoveredDate(null)
                      onClear()
                    }}
                  >
                    All time
                  </Button>
                ) : null}
                {groups.map((group, groupIndex) => (
                  <div
                    key={group[0].label}
                    className={cn(
                      "flex flex-col gap-1",
                      groupIndex > 0 &&
                        "mt-1 border-t border-popover-border pt-2"
                    )}
                  >
                    {group.map((preset) => (
                      <Button
                        key={preset.label}
                        variant="quiet"
                        className={cn(
                          "justify-start",
                          activeLabel === preset.label &&
                            "bg-muted text-foreground"
                        )}
                        aria-pressed={activeLabel === preset.label}
                        onClick={() => choosePreset(preset)}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                ))}
                <div className="mt-1 border-t border-popover-border pt-2">
                  <Button
                    variant="quiet"
                    className={cn(
                      "w-full justify-start",
                      activeLabel === "Custom range" &&
                        "bg-muted text-foreground"
                    )}
                    aria-pressed={activeLabel === "Custom range"}
                    onClick={() => {
                      setCustomArmed(true)
                      setPendingStartDate(null)
                      setHoveredDate(null)
                    }}
                  >
                    Custom range
                  </Button>
                </div>
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
                          {monthFormat.format(month)}
                        </p>
                        {isLeadingMonth ? (
                          <>
                            <span className="hidden size-7 md:block" />
                            <Button
                              variant="quiet"
                              size="icon-sm"
                              aria-label="Next month"
                              className="md:hidden"
                              disabled={leadingAtLatestMonth}
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
                            disabled={atLatestMonth}
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
                            disabled: key > today,
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
