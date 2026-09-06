"use client"

import * as React from "react"

import { shareRecipes } from "@/app/(app)/recipes/actions"
import { RoleSelect, type ShareRole } from "@/components/recipes/role-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { LabeledInput } from "@/components/ui/labeled-field"
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { useRefresh } from "@/hooks/use-refresh"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

const EMAIL_FIELD = "share-recipes-email"
const TITLE_FIELD = "share-recipes-title"

/** The selection named, without a line that runs off the dialog. */
function nameSelection(titles: string[]): string {
  if (titles.length <= 2) return titles.join(" and ")
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`
}

/**
 * Sends a selection of recipes to one address. A reader with an account gets
 * them as shares; one without gets a single link to a book holding all of
 * them, which is a snapshot of this selection rather than a live collection.
 */
export function ShareRecipesDialog({
  open,
  onOpenChange,
  recipes,
  onShared,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipes: { id: string; title: string }[]
  /** The selection has been sent; the table lets it go. */
  onShared: () => void
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<ShareRole>("viewer")
  const [title, setTitle] = React.useState("")
  const several = recipes.length > 1

  const invite = useFormSave({
    snapshot: JSON.stringify([email, role, title]),
    // An invite is a command, so the same address can be sent again.
    saved: false,
    validate: (): FormErrors =>
      email.trim() ? {} : { [EMAIL_FIELD]: "Enter an email." },
    save: async () => {
      const address = email.trim()
      const bookTitle = title.trim()
      const result = await shareRecipes({
        recipeIds: recipes.map((recipe) => recipe.id),
        email: address,
        role,
        ...(several && bookTitle ? { title: bookTitle } : {}),
      })
      if ("error" in result) return toSaveFailure(result)
      toast.add({
        title: result.guest
          ? `Invite sent to ${address}`
          : `${address} added to ${
              several
                ? bookTitle || `${recipes.length} recipes`
                : recipes[0].title
            }`,
      })
      await refresh()
      onShared()
      onOpenChange(false)
      return null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  // An address or a title still in a field is unsent work, so closing asks.
  const dismiss = () =>
    confirm(email.trim() !== "" || title.trim() !== "", () =>
      onOpenChange(false)
    )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent onKeyDown={dialogSaveShortcut(() => void invite.submit())}>
        <DialogHeader>
          <DialogTitle>
            {several ? `Share ${recipes.length} recipes` : "Share recipe"}
          </DialogTitle>
          <DialogDescription>
            Editors can change the title, description, items and steps. Viewers
            can only read.
          </DialogDescription>
        </DialogHeader>

        <p className="truncate text-sm text-muted-foreground">
          {nameSelection(recipes.map((recipe) => recipe.title))}
        </p>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void invite.submit()
          }}
        >
          {several ? (
            <LabeledInput
              id={TITLE_FIELD}
              label="Book title"
              maxLength={120}
              value={title}
              placeholder="Bar program"
              onChange={(event) => setTitle(event.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={EMAIL_FIELD}
              className="min-w-48 flex-1"
              type="email"
              value={email}
              placeholder="teammate@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            <RoleSelect value={role} onChange={setRole} />
            <Button type="submit" variant="outline" pending={invite.pending}>
              Send
            </Button>
            {invite.errors[EMAIL_FIELD] || invite.failure ? (
              <p role="alert" className="w-full text-base text-destructive">
                {invite.errors[EMAIL_FIELD] ?? invite.failure?.message}
              </p>
            ) : null}
          </div>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
