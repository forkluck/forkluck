"use client"

import * as React from "react"

import { updateAccountName } from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field"
import { LabeledInput } from "@/components/ui/labeled-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { useRefresh } from "@/hooks/use-refresh"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import type { SessionUser } from "@/lib/auth-session"
import { toSaveFailure } from "@/lib/save-failure"

const NAME_FIELD = "account-name"

/**
 * The 430px small form. Name is the only editable value — email is the
 * sign-in identifier, so it sits read-only on the inset fill.
 */
export function AccountDetailsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: SessionUser
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { pending: refreshing, refresh } = useRefresh()
  const [name, setName] = React.useState(user.name)

  const form = useFormSave({
    snapshot: name,
    validate: (): FormErrors =>
      name.trim() ? {} : { [NAME_FIELD]: "Enter a name." },
    save: async () => {
      const result = await updateAccountName(name.trim())
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then(async (done) => {
      if (!done) return
      // Saved means the header shows the new name, not that the write landed.
      await refresh()
      onOpenChange(false)
    })

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
        <DialogHeader>
          <DialogTitle>Account details</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <FieldGroup className="gap-4">
            <Field>
              <LabeledInput
                label="Name"
                id={NAME_FIELD}
                value={name}
                autoComplete="name"
                aria-invalid={Boolean(form.errors[NAME_FIELD]) || undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {form.errors[NAME_FIELD] ? (
                <FieldError>{form.errors[NAME_FIELD]}</FieldError>
              ) : null}
            </Field>
            <Field>
              <LabeledInput
                label="Email"
                id="account-email"
                value={user.email}
                readOnly
                className="bg-fill-soft text-faint"
              />
              <FieldDescription>
                Your email is how you sign in and cannot be changed here.
              </FieldDescription>
            </Field>
            {form.failure ? (
              <FieldError>{form.failure.message}</FieldError>
            ) : null}
          </FieldGroup>
          <DialogFooter className="mt-[18px]">
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending || refreshing}>
              Save
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
