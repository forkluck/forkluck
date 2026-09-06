"use client"

import * as React from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * What the Free plan's recipe cap looks like when a create is refused. The
 * body is the server's own message, so the number lives in one place.
 */
export function RecipeLimitDialog({
  message,
  onOpenChange,
}: {
  /** The refusal on screen, or null when nothing has been refused. */
  message: string | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={message !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Recipe limit reached</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button nativeButton={false} render={<Link href="/subscribe" />}>
            Upgrade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type RecipeLimit = {
  /** Whether the refusal was the cap, which the dialog then reports. */
  show: (result: { error: string; code?: string }) => boolean
  /** Rendered by whatever screen creates recipes. */
  dialog: React.ReactNode
}

/** The one place a refused create becomes the upgrade prompt. */
export function useRecipeLimitDialog(): RecipeLimit {
  const [message, setMessage] = React.useState<string | null>(null)
  const show = React.useCallback((result: { error: string; code?: string }) => {
    if (result.code !== "recipe_limit_reached") return false
    setMessage(result.error)
    return true
  }, [])

  return {
    show,
    dialog: (
      <RecipeLimitDialog
        message={message}
        onOpenChange={(next) => {
          if (!next) setMessage(null)
        }}
      />
    ),
  }
}
