import { X } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

const chipClassName =
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap"

/**
 * The 20px tag: `rounded-full`, 11.5px 500, on the bottom rung of the control
 * ladder beside the badge. At rest it is a hairline on the card fill; pressed
 * it fills with ink, never blue, because a chosen tag is a selection and not
 * data. This is the shape the allergen tags draw.
 *
 * A chip either presses or removes, never both — the X is a control of its own
 * and a button cannot sit inside a button. Pass `onPressedChange` for the
 * pressable chip (it carries `aria-pressed`), or `onRemove` for the removable
 * one, whose 12px X is labelled by `removeLabel`. With neither it is a plain
 * tag. Focus turns the border ink, like every other control here.
 */
function Chip({
  className,
  children,
  pressed = false,
  onPressedChange,
  onRemove,
  removeLabel = "Remove",
  disabled = false,
  ...props
}: Omit<React.ComponentProps<"span">, "onSelect"> & {
  /** Selected state of a pressable chip. */
  pressed?: boolean
  /** Makes the chip pressable. */
  onPressedChange?: (pressed: boolean) => void
  /** Adds the trailing X. */
  onRemove?: () => void
  /** Accessible name of the X button. */
  removeLabel?: string
  disabled?: boolean
}) {
  const tone = pressed
    ? "border-foreground bg-foreground text-background"
    : "border-border bg-card text-muted-foreground"

  if (onPressedChange && !onRemove) {
    return (
      <button
        type="button"
        data-slot="chip"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => onPressedChange(!pressed)}
        className={cn(
          chipClassName,
          tone,
          "outline-none focus-visible:border-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground",
          !pressed &&
            !disabled &&
            "hover:border-line-strong hover:text-foreground",
          className
        )}
        {...(props as React.ComponentProps<"button">)}
      >
        {children}
      </button>
    )
  }

  return (
    <span
      data-slot="chip"
      data-pressed={pressed || undefined}
      className={cn(chipClassName, tone, onRemove && "pr-1", className)}
      {...props}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          data-slot="chip-remove"
          aria-label={removeLabel}
          disabled={disabled}
          onClick={onRemove}
          className="inline-flex size-3 items-center justify-center rounded-full outline-none focus-visible:text-foreground disabled:cursor-not-allowed"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  )
}

export { Chip }
