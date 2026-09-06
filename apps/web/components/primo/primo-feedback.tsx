"use client"
import * as React from "react"
import { ThumbsUp, ThumbsDown } from "lucide-react"
import { savePrimoFeedback } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { PrimoUIMessage } from "@/lib/primo/messages"

export function PrimoFeedback({
  message,
  conversationId,
}: {
  message: PrimoUIMessage
  conversationId: string
}) {
  const [rating, setRating] = React.useState(message.feedback ?? "")
  const [comment, setComment] = React.useState(message.feedbackComment ?? "")
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState<
    "" | "up" | "down" | "clear" | null
  >(null)
  const [error, setError] = React.useState("")
  async function save(next: "" | "up" | "down") {
    setPending(next || "clear")
    setError("")
    try {
      const result = await savePrimoFeedback(
        conversationId,
        message.id,
        next,
        comment
      )
      if ("error" in result) {
        setError(result.error)
        return
      }
      setRating(next)
      setOpen(false)
    } catch {
      setError("Couldn’t save feedback. Try again.")
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Good response"
        aria-pressed={rating === "up"}
        pending={pending === "up"}
        disabled={pending !== null}
        onClick={() => void save(rating === "up" ? "" : "up")}
      >
        <ThumbsUp aria-hidden="true" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Bad response"
        aria-pressed={rating === "down"}
        disabled={pending !== null}
        onClick={() => setOpen(true)}
      >
        <ThumbsDown aria-hidden="true" />
      </Button>
      {error && !open ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next)
        }}
      >
        <DialogContent>
          <DialogTitle>What could be better?</DialogTitle>
          <DialogDescription>
            Your feedback helps us improve Primo.
          </DialogDescription>
          <Textarea
            aria-label="Feedback comment"
            placeholder="Add a comment (optional)"
            maxLength={2000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {rating ? (
              <Button
                variant="ghost"
                pending={pending === "clear"}
                disabled={pending !== null}
                onClick={() => void save("")}
              >
                Clear feedback
              </Button>
            ) : null}
            <Button
              pending={pending === "down"}
              disabled={pending !== null}
              onClick={() => void save("down")}
            >
              Send feedback
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
