import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** The one way a list grows: "+ Step", "+ Header", "+ Add". */
export function AddButton({
  onClick,
  label = "Add",
  disabled = false,
  variant = "ghost",
  className,
}: {
  onClick: () => void
  label?: string
  disabled?: boolean
  /** `outline` where the screen wants the bordered secondary look. */
  variant?: "ghost" | "outline"
  className?: string
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      // The ghost form reads in the accent and tints on hover; the outline
      // form is the plain secondary shell.
      className={cn(
        variant === "ghost" &&
          "text-primary hover:bg-brand/10 hover:text-primary focus-visible:bg-brand/10 focus-visible:text-primary",
        className
      )}
    >
      + {label}
    </Button>
  )
}
