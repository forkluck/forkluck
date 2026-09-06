"use client"
import * as React from "react"
import Image from "next/image"
import { FileText, Download } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { attachmentUrl, type PrimoAttachment } from "@/lib/primo/attachments"

export function PrimoAttachmentPreview({
  file,
  conversationId,
}: {
  file: PrimoAttachment
  conversationId: string
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [content, setContent] = React.useState("")
  const [error, setError] = React.useState("")
  const url = attachmentUrl(file.id, conversationId)
  async function preview() {
    setPending(true)
    setError("")
    try {
      const response = await fetch(`${url}&preview=text`)
      if (!response.ok) throw new Error("File unavailable")
      const result = await response.json()
      setContent(result.content)
      setOpen(true)
    } catch {
      setError("Couldn’t open this attachment. Try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="max-w-full min-w-0"
        pending={pending}
        onClick={() => void preview()}
      >
        <FileText aria-hidden="true" />
        <span className="truncate">{file.name}</span>
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogTitle className="pr-6 break-words">{file.name}</DialogTitle>
          <DialogDescription>
            {file.coverage || "Extracted document text"}
          </DialogDescription>
          <div className="max-h-[60dvh] overflow-auto">
            {file.mediaType.startsWith("image/") ? (
              <Image
                unoptimized
                src={`${url}&preview=media`}
                width={1000}
                height={1000}
                className="mb-4 h-auto max-h-80 w-full object-contain"
                alt={file.name}
              />
            ) : null}
            <pre className="font-sans text-base leading-6 break-words whitespace-pre-wrap">
              {content}
            </pre>
          </div>
          <a
            href={url}
            download
            className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm"
          >
            <Download className="size-4" aria-hidden="true" />
            Download original
          </a>
        </DialogContent>
      </Dialog>
    </>
  )
}
