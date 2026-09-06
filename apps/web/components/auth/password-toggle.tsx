"use client"

import { Eye, EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * The show/hide eye for a password field's `trailing` slot: the same quiet
 * 28px icon button the date field hangs its calendar on, so a control inside
 * a field is one thing everywhere.
 */
export function PasswordToggle({
  visible,
  onToggle,
}: {
  visible: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-sm"
      onClick={onToggle}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
    >
      {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  )
}
