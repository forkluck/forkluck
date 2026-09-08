"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import { MonthGrid, addMonths, openingMonth } from "@/components/ui/month-grid"
import { localDateKey } from "@/lib/date-presets"
import { formatMonthYear } from "@/lib/datetime"

/**
 * A single date as `YYYY-MM-DD`: the field is still typed into, and the
 * trailing button opens one month of the house calendar. Picking a day
 * writes the value and closes. No native date input, so the popup is the app's
 * own rather than the operating system's.
 */
export function DateField({
  label = "Date",
  id,
  value,
  onChange,
  placeholder,
  containerClassName,
  timeZone,
}: {
  label?: string
  id: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  containerClassName?: string
  /** The kitchen's zone: it decides which day the calendar calls today. */
  timeZone: string
}) {
  const [open, setOpen] = React.useState(false)
  const today = localDateKey(timeZone)
  const [month, setMonth] = React.useState(() => openingMonth(value, today))

  return (
    <LabeledInput
      label={label}
      id={id}
      value={value}
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      containerClassName={containerClassName}
      onChange={(event) => onChange(event.target.value)}
      trailing={
        <Popover.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (next) setMonth(openingMonth(value, today))
          }}
        >
          <Popover.Trigger
            render={
              <Button
                type="button"
                variant="quiet"
                size="icon-sm"
                aria-label={`Choose ${label.toLowerCase()}`}
              />
            }
          >
            <Calendar />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" sideOffset={8} className="z-50">
              <Popover.Popup className="w-[19rem] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
                <Popover.Title className="sr-only">Choose a date</Popover.Title>
                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label="Previous month"
                    onClick={() =>
                      setMonth((current) => addMonths(current, -1))
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <p className="text-md font-semibold">
                    {formatMonthYear(month)}
                  </p>
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label="Next month"
                    onClick={() => setMonth((current) => addMonths(current, 1))}
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <MonthGrid
                  month={month}
                  today={today}
                  decorate={(date) => ({ selected: date === value })}
                  onSelectDate={(date) => {
                    onChange(date)
                    setOpen(false)
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      }
    />
  )
}
