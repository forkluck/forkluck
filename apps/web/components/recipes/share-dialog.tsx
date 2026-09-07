"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"

import {
  removeRecipeBook,
  removeRecipeGuestLink,
  removeRecipeShare,
  shareRecipe,
  updateRecipeShare,
} from "@/app/(app)/recipes/actions"
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
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import type { RecipeDetail } from "@/lib/backend/types"
import { toSaveFailure } from "@/lib/save-failure"

const EMAIL_FIELD = "share-email"

export function ShareDialog({
  open,
  onOpenChange,
  recipeId,
  ownerName,
  shares,
  guestLinks,
  bookLinks = [],
  canEdit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recipeId: string
  ownerName: string
  shares: RecipeDetail["shares"]
  guestLinks: RecipeDetail["guestLinks"]
  /** Books this recipe was sent inside; revoking one takes the whole book. */
  bookLinks?: RecipeDetail["bookLinks"]
  /** Only the owner may invite, change a role, or take access away. */
  canEdit: boolean
}) {
  const toast = useToast()
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<ShareRole>("viewer")

  // The row whose write is in flight: its control stays busy until the list
  // the write answered with has committed, which is what the transition's
  // pending covers.
  const [running, startRun] = React.useTransition()
  const [runningId, setRunningId] = React.useState<string | null>(null)
  const busyId = running ? runningId : null

  const report = (result: object) => {
    if ("error" in result) {
      toast.add({ title: String(result.error), type: "error" })
      return false
    }
    return true
  }
  const run = (id: string, write: () => Promise<object>) => {
    // Before the transition: React holds updates made inside an async
    // transition until the action has finished.
    setRunningId(id)
    startRun(async () => {
      report(await write())
    })
  }

  const invite = useFormSave({
    snapshot: JSON.stringify([email, role]),
    // An invite is a command, so the same address can be sent again.
    saved: false,
    validate: (): FormErrors =>
      email.trim() ? {} : { [EMAIL_FIELD]: "Enter an email." },
    save: async () => {
      const address = email.trim()
      const result = await shareRecipe({ recipeId, email: address, role })
      if ("error" in result) return toSaveFailure(result)
      // An address with no account gets an invitation link for that role.
      if ("guest" in result) toast.add({ title: `Invite sent to ${address}` })
      setEmail("")
      return null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  // An address still in the field is unsent work, so closing asks first.
  const dismiss = () => confirm(email.trim() !== "", () => onOpenChange(false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent onKeyDown={dialogSaveShortcut(() => void invite.submit())}>
        <DialogHeader>
          <DialogTitle>Share recipe</DialogTitle>
          <DialogDescription>
            Editors can change the title, description, items and steps. Viewers
            can only read.
          </DialogDescription>
        </DialogHeader>

        {ownerName ? (
          <p className="text-sm text-muted-foreground">
            Owned by <span className="text-foreground">{ownerName}</span>
          </p>
        ) : null}

        {canEdit ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void invite.submit()
            }}
          >
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
              Share
            </Button>
            {invite.errors[EMAIL_FIELD] || invite.failure ? (
              <p role="alert" className="w-full text-base text-destructive">
                {invite.errors[EMAIL_FIELD] ?? invite.failure?.message}
              </p>
            ) : null}
          </form>
        ) : null}

        <div className="grid gap-2">
          {shares.map((share) => (
            <div
              key={share.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="truncate">{share.recipientName}</span>
              <div className="flex items-center gap-2">
                <RoleSelect
                  value={share.role}
                  disabled={!canEdit || busyId === share.id}
                  onChange={(next) =>
                    void run(share.id, () =>
                      updateRecipeShare({
                        recipeId,
                        shareId: share.id,
                        role: next,
                      })
                    )
                  }
                />
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${share.recipientName}`}
                    pending={busyId === share.id}
                    onClick={() =>
                      void run(share.id, () =>
                        removeRecipeShare({ recipeId, shareId: share.id })
                      )
                    }
                  >
                    {busyId === share.id ? null : <Trash2 />}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {guestLinks.map((link) => (
            <div
              key={link.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="truncate">{link.email}</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {link.role === "editor" ? "Editor" : "Viewer"} · Invited
                </span>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Revoke ${link.email}`}
                    pending={busyId === link.id}
                    onClick={() =>
                      void run(link.id, () =>
                        removeRecipeGuestLink({ recipeId, linkId: link.id })
                      )
                    }
                  >
                    {busyId === link.id ? null : <Trash2 />}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {bookLinks.map((book) => (
            <div
              key={book.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="truncate">
                {book.email} · {book.title || `${book.recipeCount} recipes`}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {book.role === "editor" ? "Editor" : "Viewer"} · Invited
                </span>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    // Named apart from the guest-link button: the same address
                    // can hold both, and this one revokes every recipe in it.
                    aria-label={`Revoke the book sent to ${book.email}`}
                    pending={busyId === book.id}
                    onClick={() =>
                      void run(book.id, () =>
                        removeRecipeBook({ bookId: book.id })
                      )
                    }
                  >
                    {busyId === book.id ? null : <Trash2 />}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {shares.length === 0 &&
          guestLinks.length === 0 &&
          bookLinks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No collaborators yet.
            </p>
          ) : null}
        </div>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
