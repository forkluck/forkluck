import { CircleCheck } from "lucide-react"

import { cn } from "@/lib/utils"

const MIN_PASSWORD_LENGTH = 8

/**
 * The one rule a password has, reported live under its field: a check
 * circle and "8 characters", faint until the field gets there, then the
 * success green. It only reports; the submit guard still says "Use at
 * least 8 characters." when it is ignored.
 */
export function PasswordHint({
  password,
  className,
}: {
  password: string
  className?: string
}) {
  const met = password.length >= MIN_PASSWORD_LENGTH
  return (
    <p
      data-slot="password-hint"
      data-met={met || undefined}
      className={cn(
        "flex items-center gap-1 text-xs leading-none transition-colors",
        met ? "text-success" : "text-faint",
        className
      )}
    >
      <CircleCheck className="size-3" aria-hidden="true" />8 characters
      <span className="sr-only">{met ? " (met)" : " (not yet met)"}</span>
    </p>
  )
}
