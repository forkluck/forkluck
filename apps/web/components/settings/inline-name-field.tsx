"use client"

import * as React from "react"

import { Input } from "@/components/ui/input"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import type { SaveFailure } from "@/lib/save-failure"

const NAME_FIELD = "inline-name"

/** The rename a settings list does in its own row: Enter writes, Escape backs
 * out, and the field closes only once the write landed. */
export function InlineNameField({
  label,
  initial,
  save,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  label: string
  initial: string
  save: (name: string) => Promise<SaveFailure | null>
  onSaved: () => void
  onCancel: () => void
  /** So the list dialog around the row can guard its own dismissal. */
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = React.useState(initial)
  const fieldRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    // The kebab returns focus to its trigger as it closes, so the field takes
    // focus a beat later.
    const timer = window.setTimeout(() => {
      fieldRef.current?.focus()
      fieldRef.current?.select()
    })
    return () => window.clearTimeout(timer)
  }, [])

  const form = useFormSave({
    snapshot: draft,
    validate: (): FormErrors =>
      draft.trim() ? {} : { [NAME_FIELD]: "Enter a name." },
    save: () => save(draft.trim()),
  })
  const { confirm, dialog } = useDirtyDialog()

  React.useEffect(() => {
    onDirtyChange(form.dirty)
    return () => onDirtyChange(false)
  }, [form.dirty, onDirtyChange])

  const submit = () =>
    void form.submit().then((done) => {
      if (done) onSaved()
    })

  return (
    <div className="min-w-0 flex-1">
      <Input
        ref={fieldRef}
        id={NAME_FIELD}
        className="h-8"
        aria-label={label}
        value={draft}
        disabled={form.pending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          dialogSaveShortcut(submit)(event)
          if (event.key === "Enter") {
            event.preventDefault()
            submit()
          }
          // Blur does nothing, or the menu's focus-return would cancel the edit.
          if (event.key === "Escape") {
            // The surrounding dialog must not close underneath the confirm.
            event.preventDefault()
            event.stopPropagation()
            confirm(form.dirty, onCancel)
          }
        }}
      />
      {form.errors[NAME_FIELD] || form.failure ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {form.errors[NAME_FIELD] ?? form.failure?.message}
        </p>
      ) : null}
      {dialog}
    </div>
  )
}
