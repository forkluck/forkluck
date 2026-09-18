import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Emphasis comes from `variant`, never from `size`:
 *   primary    → `default`      ink fill, white label. One per view.
 *   secondary  → `outline`      white with a hairline border.
 *   tertiary   → `secondary`    filled grey (the Actions button).
 *   ghost      → `ghost`        no chrome until hover; icon buttons live here.
 *   critical   → `destructive`  red fill, white label, for the dangerous main
 *                               action, and `critical` for the same action in
 *                               red ink with no chrome.
 *
 * One height: 32px, `0 12px`, 500 14px, with a 6px gap to a 14px icon. Every
 * text button is that size; forms, toolbars, dialogs and table rows share it.
 * Two icon-only sizes: `icon` (32px square, the counterpart of the text
 * button) and `icon-compact` (24px, a ghost in a row or beside a field).
 * Every button is `rounded-lg`, so a toolbar shares one corner.
 *
 * There is no elevation and no focus ring anywhere in this design. Depth is
 * one 1px --border hairline; focus turns that border ink (--foreground), which
 * is why every variant carries a border, transparent where the rest state has
 * no visible edge. Hover changes are instant — no transitions, no press shift.
 *
 * Disabled dims the label and nothing else. The greyed border and white fill
 * belong to the variants that already draw chrome at rest, because a variant
 * that draws none — `ghost`, `critical` — must not grow a box on the way to
 * being unavailable.
 *
 * `default` is the exception it has to be: its rest border is already ink, so
 * the shared focus rule would set the colour it is wearing. It focuses to
 * --background instead, the white label's colour, drawn against its own fill.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-md leading-none font-medium whitespace-nowrap outline-none select-none focus-visible:border-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
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
        // The border matches the fill rather than staying transparent: with
        // `bg-clip-padding` a transparent border would clip the grey to the
        // 30px padding box and the button would paint 2px shorter than the
        // 32px ink primary beside it.
        secondary:
          "border-secondary bg-secondary text-foreground hover:border-secondary-strong hover:bg-secondary-strong disabled:border-border disabled:bg-background aria-expanded:border-secondary-strong aria-expanded:bg-secondary-strong",
        // Also the icon button: --muted-foreground at rest, ink on hover.
        ghost:
          "text-muted-foreground hover:border-muted hover:bg-muted hover:text-foreground aria-expanded:border-muted aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "border-destructive bg-destructive text-white hover:border-destructive-strong hover:bg-destructive-strong focus-visible:border-foreground disabled:border-border disabled:bg-background",
        // The critical action that is not the main one on its screen: red
        // ink, no chrome until hover, when it takes the pale red fill.
        critical:
          "text-destructive hover:border-destructive-fill hover:bg-destructive-fill aria-expanded:border-destructive-fill aria-expanded:bg-destructive-fill",
        // A link-shaped action is ink, never blue — blue is data and
        // selection. The hairline underline firms to ink on hover, the way
        // the outline button's border does.
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-[18px]",
        // The compact icon-only button: a ghost in a table row or beside a
        // field, 24px so it reads as smaller than the button next to it.
        "icon-compact": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
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
