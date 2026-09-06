"use client"

import { Button } from "@/components/ui/button"

/** The header's Save; reads Saved or Retry after a press, as Ghost's does. */
export function SaveButton({
  pending,
  label,
  onSave,
}: {
  pending: boolean
  label: string
  onSave: () => void
}) {
  return (
    <Button type="button" pending={pending} onClick={onSave}>
      {label}
    </Button>
  )
}
