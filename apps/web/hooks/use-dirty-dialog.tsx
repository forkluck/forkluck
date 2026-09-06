"use client"

import * as React from "react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"

type DirtyDialog = {
  /** Runs `action`, or asks first when the form holds unsaved work. */
  confirm: (dirty: boolean, action: () => void) => void
  /** Rendered inside the dialog it guards. */
  dialog: React.ReactNode
}

/** The one question every dismissal path of a dirty dialog goes through. */
export function useDirtyDialog(): DirtyDialog {
  const [asking, setAsking] = React.useState<(() => void) | null>(null)

  return {
    confirm: (dirty, action) => {
      if (!dirty) {
        action()
        return
      }
      setAsking(() => action)
    },
    dialog: (
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) setAsking(null)
        }}
        title="Discard changes?"
        description="Your changes haven’t been saved. If you close now, they’ll be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          const action = asking
          setAsking(null)
          action?.()
        }}
      />
    ),
  }
}
