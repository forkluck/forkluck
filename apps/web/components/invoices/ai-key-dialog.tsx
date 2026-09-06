"use client"

import * as React from "react"
import { Key } from "lucide-react"

import {
  deleteAnthropicKey,
  saveAnthropicKey,
} from "@/app/(app)/invoices/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { LabeledInput } from "@/components/ui/labeled-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { useRefresh } from "@/hooks/use-refresh"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

const KEY_FIELD = "anthropic-key"

/**
 * Optional bring-your-own-key setup, shown only on a deployment configured for
 * the `anthropic` engine. Standard supplier invoices are parsed
 * deterministically from the PDF's text layer at no cost; the customer's own
 * Anthropic API key reads the layouts and scans that free path can't. Keys are
 * validated live before saving, stored encrypted, and never sent to the
 * browser again — only the last four characters come back.
 */
export function AiKeyDialog({
  configured,
  hint,
  trigger,
  label,
}: {
  configured: boolean
  hint: string | null
  /** The control that opens it; the icon and label are supplied here. */
  trigger?: React.ReactElement
  /** Replaces the key glyph and its label, for a plainer button. */
  label?: React.ReactNode
}) {
  const { pending: refreshing, refresh } = useRefresh()
  const [open, setOpen] = React.useState(false)
  const [key, setKey] = React.useState("")
  const [removing, setRemoving] = React.useState(false)
  const [removeError, setRemoveError] = React.useState<string | null>(null)

  const close = () => {
    setOpen(false)
    setKey("")
    setRemoveError(null)
  }

  const form = useFormSave({
    snapshot: key,
    // The key is checked against the API and stored on every submit, so the
    // same one may be sent twice.
    saved: false,
    validate: (): FormErrors =>
      key.trim() ? {} : { [KEY_FIELD]: "Enter your Anthropic API key." },
    save: async () => {
      const result = await saveAnthropicKey(key)
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then(async (done) => {
      if (!done) return
      await refresh()
      close()
    })

  // Unsent work is a key still in the field; the stored one never comes back.
  const dismiss = () => confirm(key.trim() !== "", close)

  const remove = async () => {
    setRemoving(true)
    setRemoveError(null)
    const result = await deleteAnthropicKey()
    if ("error" in result) {
      setRemoving(false)
      setRemoveError(result.error)
      return
    }
    await refresh()
    setRemoving(false)
    close()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : dismiss())}
    >
      <DialogTrigger render={trigger ?? <Button variant="outline" />}>
        {label ?? (
          <>
            <Key strokeWidth={1.8} aria-hidden="true" />
            {configured ? `AI key ····${hint ?? ""}` : "AI key (optional)"}
          </>
        )}
      </DialogTrigger>
      <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
        <DialogHeader>
          <DialogTitle>
            {configured
              ? "Your Anthropic API key"
              : "Connect an AI key (optional)"}
          </DialogTitle>
          <DialogDescription>
            Standard supplier invoices are read for free, with no AI involved.
            Your own Anthropic API key is only used when a document can&apos;t
            be read automatically: unknown layouts, scans and photos. Roughly 5¢
            per AI-read invoice, billed by Anthropic to you. Create a key at{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com
            </a>
            . It is checked against the API before saving, stored encrypted, and
            never shown again.
          </DialogDescription>
        </DialogHeader>

        {configured ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-fill-soft px-3 py-2.5">
            <span className="text-base text-muted-foreground">
              sk-ant-…{hint}
            </span>
            <Badge variant="success">Connected</Badge>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <LabeledInput
            label={
              configured
                ? "Replace with a new key (sk-ant-…)"
                : "API key (sk-ant-…)"
            }
            id={KEY_FIELD}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />

          {form.errors[KEY_FIELD] || form.failure || removeError ? (
            <p className="mt-2 text-base text-destructive" role="alert">
              {form.errors[KEY_FIELD] ?? form.failure?.message ?? removeError}
            </p>
          ) : null}

          <DialogFooter className="mt-[18px]">
            {configured ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:bg-destructive-fill hover:text-destructive"
                pending={removing}
                onClick={() => void remove()}
              >
                Remove key
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending || refreshing}>
              {configured ? "Replace key" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
