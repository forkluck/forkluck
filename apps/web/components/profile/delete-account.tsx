"use client"

import * as React from "react"

import { deleteAccount } from "@/app/(app)/profile/actions"
import { useGuardedNavigate } from "@/components/navigation-blocker"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

/**
 * The one way out of Forkluck. A red button, the typed-word confirm the
 * other whole-workspace delete uses, and then straight to /logout, which
 * clears the cookie and lands on the marketing site. The page itself must
 * not re-render after success: the account it would render is gone.
 */
export function DeleteAccount() {
  const { go } = useGuardedNavigate()
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  function onConfirm() {
    setError(null)
    startTransition(async () => {
      const result = await deleteAccount()
      if ("error" in result) {
        setOpen(false)
        setError(result.error)
        return
      }
      void go("/logout", { force: true })
    })
  }

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete account
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-md text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description="Everything in it goes too, and every phone is signed out. There is no undo."
        confirmText="DELETE"
        confirmLabel="Delete"
        pending={pending}
        onConfirm={onConfirm}
      />
    </>
  )
}
