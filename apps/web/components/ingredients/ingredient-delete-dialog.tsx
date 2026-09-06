"use client"

import * as React from "react"
import { useToast } from "@/components/ui/toast"
import { FileText } from "lucide-react"

import { deleteIngredient } from "@/app/(app)/ingredients/actions"
import { toSaveFailure } from "@/lib/save-failure"
import { GuardedLink } from "@/components/navigation-blocker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

type RecipeUsage = { id: string; publicId: string; title: string }
type DeleteResult =
  { ok: true } | { error: string; usedInRecipes?: RecipeUsage[] }

/**
 * "Delete X?", with the recipes standing in the way when there are any.
 * Both things a cook can delete out of the pantry — the ingredient and one
 * of its preparations — refuse the same way and read the same doing it.
 */
export function DeleteWithUsageDialog({
  title,
  description,
  name,
  confirmLabel,
  blockedMessage,
  open,
  onOpenChange,
  onDelete,
  onDeleted,
}: {
  title: string
  description: string
  /** The row being deleted, named on its own line. */
  name: string
  confirmLabel: string
  /** What the recipes list is introduced by when the delete is refused. */
  blockedMessage: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => Promise<DeleteResult>
  onDeleted: () => void
}) {
  const toast = useToast()
  const [pending, setPending] = React.useState(false)
  const [usedInRecipes, setUsedInRecipes] = React.useState<RecipeUsage[]>([])
  const [error, setError] = React.useState<string | null>(null)

  const runDelete = async () => {
    if (pending || usedInRecipes.length > 0) return
    setPending(true)
    setError(null)
    let result: DeleteResult
    try {
      result = await onDelete()
    } catch (cause) {
      // A stale tab's action id is gone from the server; without this the
      // click dies as an unhandled rejection and the dialog just sits there.
      result = { error: toSaveFailure(cause).message }
    }
    setPending(false)
    if ("error" in result) {
      if (result.usedInRecipes?.length) {
        setUsedInRecipes(result.usedInRecipes)
      } else {
        setError(result.error)
      }
      return
    }
    toast.add({ title: `Deleted ${name}` })
    onDeleted()
  }

  const setOpen = (next: boolean) => {
    if (pending) return
    if (!next) {
      setUsedInRecipes([])
      setError(null)
    }
    onOpenChange(next)
  }

  const blocked = usedInRecipes.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="md" className="gap-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-2">{description}</DialogDescription>

        <div className="mt-4 border-y border-border py-3 text-md font-medium text-foreground">
          {name}
        </div>

        {blocked ? (
          <div className="mt-4">
            <p className="text-base leading-[1.55] text-destructive">
              {blockedMessage}
            </p>
            <div className="mt-3 divide-y divide-muted border-y border-muted">
              {usedInRecipes.map((recipe) => (
                <GuardedLink
                  key={recipe.id}
                  href={`/recipes/${recipe.publicId}`}
                  className="flex min-h-9 items-center gap-2.5 px-1 text-base font-medium text-foreground outline-none hover:bg-fill-soft focus-visible:underline"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <FileText
                      className="size-3.5"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">{recipe.title}</span>
                </GuardedLink>
              ))}
            </div>
          </div>
        ) : error ? (
          <p className="mt-4 text-base text-destructive">{error}</p>
        ) : null}

        <div className="mt-5 flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            pending={pending}
            disabled={blocked}
            onClick={() => void runDelete()}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The pantry row itself, refused while any recipe still resolves to it. */
export function IngredientDeleteDialog({
  ingredient,
  open,
  onOpenChange,
  onDeleted,
}: {
  ingredient: { id: string; name: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  return (
    <DeleteWithUsageDialog
      title="Delete ingredient?"
      description="This permanently removes the ingredient and its related purchasing data from your library."
      name={ingredient.name}
      confirmLabel="Delete ingredient"
      blockedMessage="This ingredient can’t be deleted because it is used in the following recipes:"
      open={open}
      onOpenChange={onOpenChange}
      onDelete={() => deleteIngredient(ingredient.id)}
      onDeleted={onDeleted}
    />
  )
}
