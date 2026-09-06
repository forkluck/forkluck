"use client"

import * as React from "react"

import { mergeIngredients } from "@/app/(app)/ingredients/actions"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { type DuplicateSuggestion } from "@/lib/ingredient-insights"

type Merge = {
  keepId: string
  keepName: string
  dropId: string
  dropName: string
}

/**
 * The needs-attention banner: a 48px yellow strip over the table when the
 * pantry looks like it holds the same ingredient twice, with the merge review
 * behind its Review button. Renders nothing when the pantry is clean.
 */
export function DuplicateIngredientsBanner({
  duplicates,
}: {
  duplicates: DuplicateSuggestion[]
}) {
  const [merge, setMerge] = React.useState<Merge | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const confirmMerge = async () => {
    if (!merge) return
    setPending(true)
    setError(null)
    try {
      await mergeIngredients(merge.dropId, merge.keepId)
      setMerge(null)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn’t merge ingredients."
      )
    } finally {
      setPending(false)
    }
  }

  if (duplicates.length === 0) return null

  return (
    <NoticeBanner
      action={
        <Dialog>
          <DialogTrigger render={<NoticeBannerAction />}>Review</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Possible duplicates</DialogTitle>
              <DialogDescription>
                Merging moves recipe links, supplier products, prices, measures,
                preparations, tags, allergens, and catalog and nutrition data
                into the ingredient you keep. Where both rows have the same
                data, the kept row wins.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[55dvh] divide-y divide-muted overflow-auto rounded-xl border border-border">
              {duplicates.map((pair) => (
                <DuplicateRow
                  key={`${pair.leftId}:${pair.rightId}`}
                  pair={pair}
                  onPick={setMerge}
                />
              ))}
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogContent>

          <ConfirmDialog
            open={merge !== null}
            onOpenChange={(open) => {
              if (pending) return
              if (!open) setMerge(null)
            }}
            title="Merge these ingredients?"
            description={`${merge?.dropName ?? ""} is removed after its linked data moves to ${merge?.keepName ?? ""}. Tags are combined; conflicting values stay as they are on ${merge?.keepName ?? ""}.`}
            confirmLabel={pending ? "Merging…" : "Merge ingredients"}
            pending={pending}
            onConfirm={confirmMerge}
          />
        </Dialog>
      }
    >
      {duplicates.length === 1
        ? "One pair of ingredients looks like a duplicate"
        : `${duplicates.length} pairs of ingredients look like duplicates`}
    </NoticeBanner>
  )
}

function DuplicateRow({
  pair,
  onPick,
}: {
  pair: DuplicateSuggestion
  onPick: (merge: Merge) => void
}) {
  return (
    <div className="px-3.5 py-3">
      <p className="text-md">
        {pair.leftName} <span className="text-disabled-foreground">/</span>{" "}
        {pair.rightName}
      </p>
      <p className="mt-0.5 text-xs text-faint">{pair.reason}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            onPick({
              keepId: pair.leftId,
              keepName: pair.leftName,
              dropId: pair.rightId,
              dropName: pair.rightName,
            })
          }
        >
          Keep {pair.leftName}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            onPick({
              keepId: pair.rightId,
              keepName: pair.rightName,
              dropId: pair.leftId,
              dropName: pair.leftName,
            })
          }
        >
          Keep {pair.rightName}
        </Button>
      </div>
    </div>
  )
}
