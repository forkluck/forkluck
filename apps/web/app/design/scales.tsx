import type { GuideSection } from "./demos"
import { cn } from "@/lib/utils"

/**
 * The three ladders the app is built on, drawn as objects rather than listed
 * as numbers, so a "do we need both of these?" question can be answered by
 * looking. Each rung carries the jobs AGENTS.md gives it; a rung with almost
 * nothing beside it is a candidate for the next cut.
 */

const TYPE_STEPS: {
  step: string
  px: string
  jobs: string
  className: string
}[] = [
  {
    step: "xs",
    px: "12",
    jobs: "Badges, chips, menu group labels, tooltips, chart ticks",
    className: "text-xs",
  },
  {
    step: "sm",
    px: "13",
    jobs: "The tooltip (on trial)",
    className: "text-sm",
  },
  {
    step: "md",
    px: "14",
    jobs: "Body, controls, fields, help text, every heading below the page title",
    className: "text-md",
  },
  {
    step: "lg",
    px: "16",
    jobs: "The iOS field floor, the wordmark, inline figures",
    className: "text-lg",
  },
  {
    step: "2xl",
    px: "24",
    jobs: "Page titles and every numeral: metric cards, the hero figure",
    className: "text-2xl",
  },
]

function TypeScaleDemo() {
  return (
    <div className="flex flex-col gap-4">
      {TYPE_STEPS.map(({ step, px, jobs, className }) => (
        <div
          key={step}
          className="grid grid-cols-[56px_1fr] items-baseline gap-x-6 md:grid-cols-[56px_minmax(0,320px)_1fr]"
        >
          <span className="text-md text-muted-foreground">
            {step} <span className="tabular-nums">{px}</span>
          </span>
          <span
            className={cn(
              "leading-none tracking-normal",
              className,
              step === "2xl" && "font-semibold tracking-[-0.02em]",
              step === "md" && "font-semibold",
              (step === "3xl" || step === "4xl") && "font-semibold tabular-nums"
            )}
          >
            {step === "3xl"
              ? "28.4%"
              : step === "4xl"
                ? "$1.14"
                : "Butter croissant"}
          </span>
          <span className="col-span-2 text-md text-muted-foreground md:col-span-1">
            {jobs}
          </span>
        </div>
      ))}
    </div>
  )
}

const RADII: { step: string; px: string; jobs: string; className: string }[] = [
  {
    step: "sm",
    px: "4",
    jobs: "Row tags, the tiny chip",
    className: "rounded-sm",
  },
  {
    step: "md",
    px: "6",
    jobs: "Fields, menu items, row badges",
    className: "rounded-md",
  },
  {
    step: "lg",
    px: "10",
    jobs: "Buttons, popovers, nav items, banners",
    className: "rounded-lg",
  },
  {
    step: "xl",
    px: "14",
    jobs: "Cards, dialogs, the empty state",
    className: "rounded-xl",
  },
  { step: "2xl", px: "18", jobs: "The app frame", className: "rounded-2xl" },
  {
    step: "full",
    px: "",
    jobs: "Badges, pills, switch, spinner, avatar",
    className: "rounded-full",
  },
]

function RadiusDemo() {
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-6">
      {RADII.map(({ step, px, jobs, className }) => (
        <div key={step} className="flex w-40 flex-col gap-3">
          <div
            className={cn("size-16 border border-border bg-card", className)}
          />
          <span className="text-md text-muted-foreground">
            {step}
            {px ? <span className="tabular-nums"> {px}px</span> : null}
          </span>
          <span className="text-md text-muted-foreground">{jobs}</span>
        </div>
      ))}
    </div>
  )
}

const HEIGHTS: { px: number; name: string; jobs: string }[] = [
  { px: 20, name: "badge", jobs: "Badges and chips" },
  {
    px: 24,
    name: "compact",
    jobs: "The compact icon button, in rows and beside fields",
  },
  {
    px: 32,
    name: "button",
    jobs: "Every button, the search field, the tab pills, menu triggers",
  },
  { px: 36, name: "field", jobs: "Inputs and selects" },
]

function ControlHeightsDemo() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end gap-6">
        {HEIGHTS.map(({ px, name }) => (
          <div key={px} className="flex flex-col items-start gap-2">
            <div
              className="flex w-28 items-center rounded-lg border border-input bg-card px-3 text-md"
              style={{ height: px }}
            >
              {px}px
            </div>
            <span className="text-md text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {HEIGHTS.map(({ px, jobs }) => (
          <div key={px} className="grid grid-cols-[56px_1fr] gap-x-6">
            <span className="text-md text-muted-foreground tabular-nums">
              {px}px
            </span>
            <span className="text-md text-muted-foreground">{jobs}</span>
          </div>
        ))}
      </div>
      <p className="max-w-[60ch] text-md leading-[1.55] text-muted-foreground">
        Layout heights are off this ladder on purpose: table rows 44, header
        rows 48, sidebar items 44, the floating field 52, the full-page spinner
        80, the main header 58.
      </p>
    </div>
  )
}

export const SECTIONS_C: GuideSection[] = [
  { id: "type-scale", title: "Type scale", Demo: TypeScaleDemo },
  { id: "radius", title: "Radius", Demo: RadiusDemo },
  { id: "control-heights", title: "Control heights", Demo: ControlHeightsDemo },
]
