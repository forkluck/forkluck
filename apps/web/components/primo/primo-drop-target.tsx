"use client"

import * as React from "react"
import { FileUp } from "lucide-react"
import { usePrimo } from "./primo-provider"
import { usePrimoDraft } from "./primo-drafts"
import { cn } from "@/lib/utils"

/** The visible Home/rail owns drops; other kitchen upload areas keep theirs. */
export function PrimoDropTarget({
  children,
  className,
  id,
}: {
  children: React.ReactNode
  className?: string
  id?: string
}) {
  const { conversationId, conversationLoading, conversationError } = usePrimo()
  const [, , attachments] = usePrimoDraft(conversationId)
  const [dragging, setDragging] = React.useState(false)
  const depth = React.useRef(0)
  const disabled = conversationLoading || Boolean(conversationError)
  const reset = React.useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])
  React.useEffect(() => {
    window.addEventListener("dragend", reset)
    window.addEventListener("drop", reset)
    window.addEventListener("blur", reset)
    return () => {
      window.removeEventListener("dragend", reset)
      window.removeEventListener("drop", reset)
      window.removeEventListener("blur", reset)
    }
  }, [reset])
  return (
    <div
      id={id}
      data-primo-drop-target
      className={cn("relative flex min-h-0 w-full flex-1 flex-col", className)}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        event.dataTransfer.dropEffect = disabled ? "none" : "copy"
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        event.stopPropagation()
        reset()
        if (!disabled) attachments.add(Array.from(event.dataTransfer.files))
      }}
    >
      {children}
      {dragging ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-4 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground bg-background/95 p-6 text-center"
        >
          <div>
            <FileUp className="mx-auto mb-3 size-8" aria-hidden="true" />
            <p className="text-lg font-semibold">
              {disabled
                ? "Wait for this chat to load"
                : "Drop recipes or invoices here"}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {conversationError ||
                "PDFs, photos and documents · up to five files, 20 MB combined"}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
