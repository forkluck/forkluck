import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Emphasis comes from `variant`, never from `size`. Four levels:
 *   1 primary     → `default`    ink fill, white label. One per view.
 *   2 secondary   → `outline`    white with a hairline border (the ghost button).
 *   3 tertiary    → `secondary`  filled grey (the Actions button).
 *   4 quaternary  → `ghost`      no chrome until hover — icon buttons live here.
 * `destructive` sits outside the scale, for dangerous actions; `filter` is the
 * toolbar pill (quiet label, ink value); `link` is the link-shaped action, ink
 * on a hairline underline that firms on hover.
 *
 * Every button, text or icon-only, is `rounded-lg`, so a toolbar of mixed
 * sizes shares one corner. Text buttons are 32px tall, `0 12px`, 500 13px,
 * with a 6px gap to a 14px icon:
 *   xs      (24px) → tightest inline actions
 *   sm      (28px) → inside table rows, step cards, inline banners
 *   default (32px) → standard: page headers, toolbars, dialogs, forms
 *   lg      (36px) → full-width form submits; matches Input height
 *
 * The four icon sizes are the square counterparts at the same four heights —
 * `icon` is a 32px `default`, `icon-lg` a 36px `lg` — so an icon button and
 * the text button beside it line up without either one being special.
 *
 * There is no elevation and no focus ring anywhere in this design. Depth is
 * one 1px --border hairline; focus turns that border ink (--foreground), which
 * is why every variant carries a border, transparent where the rest state has
 * no visible edge. Hover changes are instant — no transitions, no press shift.
 *
 * Disabled dims the label and nothing else. The greyed border and white fill
 * belong to the variants that already draw chrome at rest, because a variant
 * that draws none — `ghost`, `quiet`, `link` — must not grow a box on the way
 * to being unavailable: a row's `…` sprouting an empty outline reads as a
 * button that broke, not one there is nothing behind.
 *
 * `default` is the exception it has to be: its rest border is already ink, so
 * the shared focus rule would set the colour it is wearing and the primary
 * button on every screen would take focus with no visible change at all. It
 * focuses to --background instead — the white label's colour, drawn against
 * its own ink fill.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm leading-none font-medium whitespace-nowrap outline-none select-none focus-visible:border-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        // Filled buttons are ink, not the accent — blue is reserved for data
        // and selection. Hover lifts one neutral step to --ink-soft, border
        // and fill together, so the button keeps a single flat silhouette.
        // Disabled keeps the ink fill, dimmed — the primary never goes white.
        default:
          "border-foreground bg-foreground text-background hover:border-ink-soft hover:bg-ink-soft focus-visible:border-background disabled:border-foreground/60 disabled:bg-foreground/60 disabled:text-background aria-expanded:border-ink-soft aria-expanded:bg-ink-soft",
        // Ghost: the fill never changes, only the line firms up. The grey fill
        // is reserved for the open-popover state, so a trigger reads as held.
        outline:
          "border-input bg-card text-foreground hover:border-line-strong disabled:border-border disabled:bg-background aria-expanded:bg-muted",
        // The toolbar filter pill: same shell as `outline`, but the label is
        // the quiet half and the value inside it carries the ink and the
        // weight. Wrap the value in <span className="font-medium
        // text-foreground"> — that is the whole pattern.
        filter:
          "border-input bg-card font-normal text-muted-foreground hover:border-line-strong disabled:border-border disabled:bg-background aria-expanded:border-line-strong data-popup-open:border-line-strong",
        // The border matches the fill rather than staying transparent: with
        // `bg-clip-padding` a transparent border would clip the grey to the
        // 30px padding box and the button would paint 2px shorter than the
        // 32px ink primary beside it.
        secondary:
          "border-secondary bg-secondary text-foreground hover:border-secondary-strong hover:bg-secondary-strong disabled:border-border disabled:bg-background aria-expanded:border-secondary-strong aria-expanded:bg-secondary-strong",
        // Also the icon button: --muted-foreground at rest, ink on hover.
        ghost:
          "text-muted-foreground hover:border-muted hover:bg-muted hover:text-foreground aria-expanded:border-muted aria-expanded:bg-muted aria-expanded:text-foreground",
        quiet:
          "text-muted-foreground hover:border-muted hover:bg-muted hover:text-foreground aria-expanded:border-muted aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "border-destructive bg-destructive text-white hover:border-destructive-strong hover:bg-destructive-strong focus-visible:border-foreground disabled:border-border disabled:bg-background",
        // A link-shaped action is ink, never blue — blue is data and
        // selection. The hairline underline firms to ink on hover, the way
        // the outline button's border does.
        link: "text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-9 gap-1.5 px-6 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-[19px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `pending` is the in-flight state of an async action: the button disables (so
 * a second press is dropped), announces `aria-busy`, and leads with the sm
 * Spinner while keeping its label — the width barely moves and the intent
 * stays readable. The disabled grey is deliberate: it is the same rest the
 * app's "Saving…" buttons already take.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  pending = false,
  disabled,
  children,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & { pending?: boolean }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-pending={pending || undefined}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {pending ? <Spinner size="sm" label="" className="-ml-0.5" /> : null}
      {children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
