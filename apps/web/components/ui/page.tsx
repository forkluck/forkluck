import * as React from "react"
import { ChevronRight } from "lucide-react"
import { GuardedLink } from "@/components/navigation-blocker"
import { cn } from "@/lib/utils"

/**
 * The chrome every screen shares. These pieces are the whole reason the
 * twelve screens line up: padding, title metrics, the toolbar rhythm and the
 * empty card were each hand-rolled per screen in the first pass and drifted
 * by 3–16px between them.
 *
 *   <Page>
 *     <PageHeader>
 *       <div className="flex min-w-0 flex-col gap-1">
 *         <PageParents><PageParent href="/ingredients">Ingredients</PageParent></PageParents>
 *         <PageTitle>Butter</PageTitle>
 *       </div>
 *     </PageHeader>
 *     <Toolbar>… <ToolbarSpacer /> …</Toolbar>
 *     …
 *   </Page>
 */

/** The centered variant's content column. */
const PAGE_CONTENT_MAX_WIDTH = "max-w-[1280px]"

/**
 * `<main>` with `0 24px 34px` of screen padding (the header above supplies
 * the top), in one of
 * two width modes. The shell stays full-bleed either way — the mockup's
 * 1280px framed window was dropped — so the choice is only how far the
 * *content* is allowed to run:
 *
 *   "centered" (default) — a 1280px column, centered in the main area. Every
 *     list and detail screen: at 1800px a table stretched edge to edge is a
 *     mile of whitespace between the name and its numbers.
 *   "wide" — the content grid is the viewport's. Analytics and the Products
 *     hub: their cards and tables reflow into the extra width instead of
 *     stranding it.
 */
function Page({
  variant = "centered",
  className,
  children,
  ...props
}: React.ComponentProps<"main"> & { variant?: "centered" | "wide" }) {
  return (
    <main
      data-slot="screen"
      data-variant={variant}
      className={cn("w-full px-4 pb-8 sm:px-6 md:px-6 md:pb-[34px]", className)}
      {...props}
    >
      {variant === "centered" ? (
        <div className={cn("mx-auto w-full", PAGE_CONTENT_MAX_WIDTH)}>
          {children}
        </div>
      ) : (
        children
      )}
    </main>
  )
}

/**
 * The title row: baseline-aligned, 20px above whatever follows. `justify-between`
 * so a screen can hang one control off the right edge of the title line.
 *
 * It scrolls away with the content it labels. The 20px gap stays padding rather
 * than margin so it collapses with nothing above it.
 */
function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header"
      className={cn("flex items-end justify-between gap-4 pb-5", className)}
      {...props}
    />
  )
}

/**
 * 600 24px, letter-spacing -.02em, on the font's own leading (a 32px Tailwind
 * line box would push the toolbar 3px down). Baseline flex so a badge or save
 * status sits on the title's baseline.
 */
function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-title"
      className={cn(
        "flex min-w-0 items-baseline gap-2 text-2xl leading-[normal] font-semibold tracking-[-0.02em] text-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * The way back, on its own line above the title instead of a slash breadcrumb
 * beside it. Usually one parent; two where a section nests.
 */
function PageParents({
  children,
  className,
  ...props
}: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="Up"
      data-slot="page-parents"
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-md font-semibold",
        className
      )}
      {...props}
    >
      {React.Children.toArray(children).map((child, index) => (
        <React.Fragment key={index}>
          {/* The separator belongs to the line so no screen can draw its own. */}
          {index > 0 ? (
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 text-disabled-foreground"
            />
          ) : null}
          {child}
        </React.Fragment>
      ))}
    </nav>
  )
}

/** One step up, in the accent. */
function PageParent({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <GuardedLink
      href={href}
      className="min-w-0 truncate rounded-sm text-primary outline-none hover:underline focus-visible:underline"
    >
      {children}
    </GuardedLink>
  )
}

/**
 * Search · filters · spacer · actions, 8px apart, 16px above the content it
 * filters. Every screen's toolbar is this row — `DataTable` builds its own
 * from the same values.
 *
 * On a phone the row becomes a stack, each control full width. A screen with
 * several small controls groups them itself (`<div className="flex flex-wrap
 * items-center gap-2 md:contents">`) so they share one line down there.
 */
function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar"
      className={cn(
        "mb-4 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center",
        className
      )}
      {...props}
    />
  )
}

/** The gap the design puts between a toolbar's filters and its actions. */
function ToolbarSpacer({ className, ...props }: React.ComponentProps<"div">) {
  // Nothing to space out while the toolbar is a stack, and a growing spacer
  // there would only add height.
  return <div className={cn("hidden flex-1 md:block", className)} {...props} />
}

/**
 * The one empty card in the app: `rounded-xl`, `64px 24px`, a 17px title over
 * 46ch of copy, then a black primary and a ghost import. Children are the
 * action row — pass the buttons, nothing else.
 */
function EmptyState({
  title,
  description,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "rounded-xl border border-border bg-card px-6 py-16 text-center",
        className
      )}
      {...props}
    >
      <h2 className="text-xl leading-[normal] font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </h2>
      {description ? (
        <p className="mx-auto mt-2 max-w-[46ch] text-base leading-[1.65] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export {
  EmptyState,
  Page,
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
  Toolbar,
  ToolbarSpacer,
}
