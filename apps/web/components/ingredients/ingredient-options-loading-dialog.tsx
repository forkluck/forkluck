"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export function IngredientOptionsLoadingDialog({
  open,
  error,
  onOpenChange,
  onRetry,
}: {
  open: boolean
  error: boolean
  onOpenChange: (open: boolean) => void
  onRetry: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          {error ? "Ingredients unavailable" : "Loading ingredients"}
        </DialogTitle>
        {error ? (
          <div className="space-y-4">
            <p className="text-md leading-5 text-muted-foreground">
              We couldn’t load the pantry list. Try again before continuing so
              imported lines can be matched safely.
            </p>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        ) : (
          <div className="grid h-24 place-items-center">
            <Spinner label="Loading ingredients" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
