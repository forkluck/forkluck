"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { LabeledInput } from "@/components/ui/labeled-field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * The one confirm shape in the app — destructive actions and the
 * unsaved-changes guard both land here. A narrow card, a title that asks the
 * question, a body that names the consequence, and two equal buttons: grey to
 * back out, ink or red to go through with it. No close button, because both
 * answers are already on screen.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmText,
  variant = "destructive",
  pending = false,
  onConfirm,
  onCancel,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  /** One sentence naming what happens. */
  description: React.ReactNode
  confirmLabel: React.ReactNode
  cancelLabel?: React.ReactNode
  /** Word the user has to type before the confirm button unlocks, for the
   *  deletes that take more than one row with them. */
  confirmText?: string
  /** `destructive` for deletes, `default` for a plain ink confirm (Save). */
  variant?: "destructive" | "default"
  pending?: boolean
  onConfirm: () => void | Promise<void>
  /**
   * What the grey button does, when that is more than dismissing. The
   * unsaved-changes guard needs it: there "Discard" actively throws the edits
   * away, while Escape and the scrim only take the guard back off screen.
   * Defaults to closing.
   */
  onCancel?: () => void
  className?: string
}) {
  const [typed, setTyped] = React.useState("")
  // A cancelled confirm must not leave the word standing for the next one, and
  // the reset belongs in render: the dialog can be closed from outside too.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setTyped("")
  }
  const locked = confirmText !== undefined && typed !== confirmText

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <DialogContent showCloseButton={false} className={cn("gap-0", className)}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-2">{description}</DialogDescription>
        {confirmText === undefined ? null : (
          <LabeledInput
            containerClassName="mt-4"
            label={`Type ${confirmText} to confirm`}
            value={typed}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => setTyped(event.target.value)}
          />
        )}
        {/* Two flex:1 buttons, so neither answer reads as the safe default by
            being the wider one. */}
        <div className="mt-5 flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={pending}
            onClick={() => (onCancel ? onCancel() : onOpenChange(false))}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            className="flex-1"
            disabled={locked}
            pending={pending}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
