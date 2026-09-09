"use client"

import * as React from "react"

import { PasswordToggle } from "@/components/auth/password-toggle"
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
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useRefresh } from "@/hooks/use-refresh"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { authClient } from "@/lib/auth-client"
import { toSaveFailure } from "@/lib/save-failure"

const CURRENT_FIELD = "change-password-current"
const NEW_FIELD = "change-password-new"
const CONFIRM_FIELD = "change-password-confirm"

export function ChangePasswordDialog({
  open,
  onOpenChange,
  hasPassword,
}: {
  open: boolean
  hasPassword: boolean
  onOpenChange: (open: boolean) => void
}) {
  const toast = useToast()
  const { refresh, pending: refreshing } = useRefresh()
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [confirmation, setConfirmation] = React.useState("")
  const [currentVisible, setCurrentVisible] = React.useState(false)
  const [newVisible, setNewVisible] = React.useState(false)
  const [confirmationVisible, setConfirmationVisible] = React.useState(false)

  const form = useFormSave({
    snapshot: JSON.stringify([currentPassword, newPassword, confirmation]),
    saved: false,
    validate: (): FormErrors => {
      if (hasPassword && !currentPassword)
        return { [CURRENT_FIELD]: "Enter your current password." }
      if (newPassword.length < 8)
        return { [NEW_FIELD]: "Use at least 8 characters." }
      if (newPassword !== confirmation)
        return { [CONFIRM_FIELD]: "The new passwords don’t match." }
      return {}
    },
    save: async () => {
      const result = await authClient.changePassword({
        ...(hasPassword ? { currentPassword } : {}),
        newPassword,
      })
      return result.error ? toSaveFailure(result.error.message) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then(async (done) => {
      if (!done) return
      await refresh()
      onOpenChange(false)
      toast.add({ title: hasPassword ? "Password changed." : "Password set." })
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
          <DialogTitle>
            {hasPassword ? "Change password" : "Set a password"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <FieldGroup className="gap-4">
            {hasPassword ? (
              <Field>
                <LabeledInput
                  label="Current password"
                  id={CURRENT_FIELD}
                  type={currentVisible ? "text" : "password"}
                  autoComplete="current-password"
                  autoFocus
                  value={currentPassword}
                  aria-invalid={
                    Boolean(form.errors[CURRENT_FIELD]) || undefined
                  }
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  trailing={
                    <PasswordToggle
                      visible={currentVisible}
                      onToggle={() => setCurrentVisible((visible) => !visible)}
                    />
                  }
                />
                {form.errors[CURRENT_FIELD] ? (
                  <FieldError>{form.errors[CURRENT_FIELD]}</FieldError>
                ) : null}
              </Field>
            ) : null}
            <Field>
              <LabeledInput
                label="New password"
                id={NEW_FIELD}
                autoFocus={!hasPassword}
                type={newVisible ? "text" : "password"}
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                aria-invalid={Boolean(form.errors[NEW_FIELD]) || undefined}
                onChange={(event) => setNewPassword(event.target.value)}
                trailing={
                  <PasswordToggle
                    visible={newVisible}
                    onToggle={() => setNewVisible((visible) => !visible)}
                  />
                }
              />
              <FieldDescription>At least 8 characters.</FieldDescription>
              {form.errors[NEW_FIELD] ? (
                <FieldError>{form.errors[NEW_FIELD]}</FieldError>
              ) : null}
            </Field>
            <Field>
              <LabeledInput
                label="Confirm new password"
                id={CONFIRM_FIELD}
                type={confirmationVisible ? "text" : "password"}
                autoComplete="new-password"
                minLength={8}
                value={confirmation}
                aria-invalid={Boolean(form.errors[CONFIRM_FIELD]) || undefined}
                onChange={(event) => setConfirmation(event.target.value)}
                trailing={
                  <PasswordToggle
                    visible={confirmationVisible}
                    onToggle={() =>
                      setConfirmationVisible((visible) => !visible)
                    }
                  />
                }
              />
              {form.errors[CONFIRM_FIELD] ? (
                <FieldError>{form.errors[CONFIRM_FIELD]}</FieldError>
              ) : null}
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
              {hasPassword ? "Change password" : "Set password"}
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
