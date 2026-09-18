"use client"

import * as React from "react"
import { Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The file drop target: a dashed `rounded-xl` box on `--fill-soft` with a
 * 17px `Upload`, one line of copy and an outline "Choose files" button, in the
 * look the invoices screen takes while a drag is over it. The dashed line is
 * `--line-strong` at rest and firms to ink while files are over the box, which
 * is the same move hover and focus make everywhere else in this design.
 *
 * The whole box is the hit area, keyboard included: it is a button-like region
 * that opens the hidden file input on Enter or Space, and the "Choose files"
 * button inside it is the visible affordance for a pointer. The box is not on
 * the control-height ladder; it is a surface, like a card, so it takes the
 * card radius and its own `py-16` height.
 *
 * A drag only counts when it carries files. A text selection or a dragged link
 * reports no `Files` type, and swallowing those drags would take the drop away
 * from whatever the page would otherwise do with it.
 */
function dragCarriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files")
}

function DropZone({
  accept,
  multiple = false,
  onFiles,
  disabled = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onDrop" | "children"> & {
  accept?: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  disabled?: boolean
  /** A hint under the copy, such as the accepted types and size cap. */
  children?: React.ReactNode
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Nested children fire their own dragenter/dragleave, so the state follows a
  // depth count rather than the last event seen.
  const dragDepth = React.useRef(0)
  const [dragging, setDragging] = React.useState(false)

  function endDrag() {
    dragDepth.current = 0
    setDragging(false)
  }

  function open() {
    if (disabled) return
    inputRef.current?.click()
  }

  return (
    <div
      data-slot="drop-zone"
      data-dragging={dragging || undefined}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        open()
      }}
      onDragEnter={(event) => {
        if (disabled || !dragCarriesFiles(event)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (disabled || !dragCarriesFiles(event)) return
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (disabled || !dragCarriesFiles(event)) return
        dragDepth.current -= 1
        if (dragDepth.current <= 0) endDrag()
      }}
      onDrop={(event) => {
        if (disabled || !dragCarriesFiles(event)) return
        event.preventDefault()
        endDrag()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) onFiles(files)
      }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong bg-fill-soft px-6 py-16 text-center outline-none",
        disabled
          ? "cursor-not-allowed text-disabled-foreground"
          : "cursor-pointer focus-visible:border-foreground data-dragging:border-foreground",
        className
      )}
      {...props}
    >
      <Upload
        className="size-[17px] text-muted-foreground"
        strokeWidth={2}
        aria-hidden="true"
      />
      <p className="text-md text-foreground">Drop files here</p>
      {children ? (
        <p className="text-md text-muted-foreground">{children}</p>
      ) : null}
      <Button
        variant="outline"
        disabled={disabled}
        // The box already opens the input; the button only has to stop the
        // click from opening it a second time on the way up.
        onClick={(event) => {
          event.stopPropagation()
          open()
        }}
      >
        Choose files
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        // The input's own click bubbles back to the box, which would answer it
        // by opening the picker a second time.
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // The same file picked twice in a row is the same value, and without
          // this reset the second pick fires no change event at all.
          event.target.value = ""
          if (files.length > 0) onFiles(files)
        }}
      />
    </div>
  )
}

export { DropZone }
