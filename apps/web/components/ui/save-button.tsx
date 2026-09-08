"use client"

import { Button } from "@/components/ui/button"
import { Kbd, useShortcutLabel } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The header's Save; reads Saved or Retry after a press, as Ghost's does.
 * Hovering it names the shortcut, which is otherwise a secret.
 */
export function SaveButton({
  pending,
  label,
  onSave,
}: {
  pending: boolean
  label: string
  onSave: () => void
}) {
  const shortcut = useShortcutLabel("S")
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button type="button" pending={pending} onClick={onSave} />}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>
        Save <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
