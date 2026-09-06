"use client"

import * as React from "react"
import { ThumbsDown, ThumbsUp } from "lucide-react"

import { saveReceiptFeedback } from "@/app/(app)/invoices/actions"
import type { IngredientOption } from "@/components/ingredients/types"
import {
  invoiceState,
  receiptFeedbackSnapshot,
  type InvoiceState,
} from "@/components/invoices/receipt-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

export function ReceiptFeedback({
  invoice,
  ingredients,
  onSaved,
}: {
  invoice: InvoiceState
  ingredients: IngredientOption[]
  onSaved: (feedback: NonNullable<InvoiceState["feedback"]>) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [id] = React.useState(() => invoice.feedback?.id ?? crypto.randomUUID())
  const [rating, setRating] = React.useState<"up" | "down">(
    invoice.feedback?.rating ?? "up"
  )
  const [note, setNote] = React.useState(invoice.feedback?.note ?? "")
  const noteId = React.useId()
  const { confirm, dialog } = useDirtyDialog()
  const form = useFormSave({
    snapshot: JSON.stringify({ rating, note }),
    saved: false,
    validate: () =>
      note.length > 2000
        ? { [noteId]: "Keep your note under 2,000 characters." }
        : {},
    save: async () => {
      const sent = { id, rating, note: note.trim() }
      const result = await saveReceiptFeedback({
        ...sent,
        fileName: invoice.result.fileName,
        supplierName: invoice.result.supplierName,
        model: invoice.result.extractionModel,
        extraction: invoice.result.extraction,
        original: receiptFeedbackSnapshot(
          invoiceState(invoice.fileKey, invoice.result),
          ingredients
        ),
        corrected: receiptFeedbackSnapshot(invoice, ingredients),
      })
      if ("error" in result) return toSaveFailure(result)
      onSaved(sent)
      return null
    },
  })

  const begin = (next: "up" | "down") => {
    setRating(next)
    setNote(invoice.feedback?.note ?? "")
    setOpen(true)
  }
  const dismiss = () => {
    if (form.pending) return
    confirm(
      note.trim() !== (invoice.feedback?.note ?? "") ||
        rating !== invoice.feedback?.rating,
      () => setOpen(false)
    )
  }
  const submit = () =>
    void form.submit().then((done) => {
      if (done) setOpen(false)
    })

  return (
    <div className="ml-auto flex items-center gap-1">
      <span className="mr-1 text-xs text-faint" role="status">
        {invoice.feedback ? "Feedback sent" : "Feedback"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Receipt read correctly"
        title="Receipt read correctly"
        aria-pressed={invoice.feedback?.rating === "up"}
        onClick={() => begin("up")}
      >
        <ThumbsUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Report a receipt problem"
        title="Report a receipt problem"
        aria-pressed={invoice.feedback?.rating === "down"}
        onClick={() => begin("down")}
      >
        <ThumbsDown aria-hidden="true" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : dismiss())}
      >
        <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
          <DialogHeader>
            <DialogTitle>Receipt feedback</DialogTitle>
            <DialogDescription>
              Help us improve receipt reading. Includes the original read and
              your edits so far.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <fieldset disabled={form.pending} className="space-y-4">
              <div
                className="flex gap-2"
                role="group"
                aria-label="Receipt rating"
              >
                <Button
                  type="button"
                  variant={rating === "up" ? "default" : "outline"}
                  aria-pressed={rating === "up"}
                  onClick={() => setRating("up")}
                >
                  <ThumbsUp aria-hidden="true" /> Looks right
                </Button>
                <Button
                  type="button"
                  variant={rating === "down" ? "default" : "outline"}
                  aria-pressed={rating === "down"}
                  onClick={() => setRating("down")}
                >
                  <ThumbsDown aria-hidden="true" /> Needs work
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor={noteId}>
                  {rating === "down"
                    ? "What went wrong? (optional)"
                    : "Anything to add? (optional)"}
                </Label>
                <Textarea
                  id={noteId}
                  value={note}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={
                    rating === "down"
                      ? "Wrong quantity, highlight, missing item, or a slow read…"
                      : undefined
                  }
                />
              </div>
            </fieldset>
            {form.failure || form.errors[noteId] ? (
              <p className="mt-2 text-base text-destructive" role="alert">
                {form.failure?.message ?? form.errors[noteId]}
              </p>
            ) : null}
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={dismiss}
                disabled={form.pending}
              >
                Cancel
              </Button>
              <Button type="submit" pending={form.pending}>
                {invoice.feedback ? "Update feedback" : "Send feedback"}
              </Button>
            </DialogFooter>
          </form>
          {dialog}
        </DialogContent>
      </Dialog>
    </div>
  )
}
