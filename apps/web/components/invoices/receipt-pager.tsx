"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"

/** Where a keystroke belongs to the thing under it, not to the pager: a field
 * being typed in, or an open combobox / listbox / menu moving its highlight. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return (
    target.closest('[role="combobox"],[role="listbox"],[role="menu"]') !== null
  )
}

/**
 * The reviewer's one row of chrome: which receipt this is, how to get to the
 * next one, and the two decisions — Import or Skip — that make it leave.
 */
export function ReceiptPager({
  title,
  subtitle,
  position,
  count,
  filesCount,
  readingLabel,
  busy,
  blocker,
  importing,
  isDriveFile,
  onPrev,
  onNext,
  onShowFiles,
  onImport,
  onSkip,
  onNeverOffer,
  children,
}: {
  /** The supplier, as reviewed. */
  title: string
  /** The invoice number, or the file name when it printed none. */
  subtitle: string
  /** 1-based place in the list. */
  position: number
  count: number
  filesCount: number
  /** "Reading 3 of 12 files…" while the queue is still working, else null. */
  readingLabel: string | null
  busy: boolean
  /** Why Import is disabled for this receipt, or null when it can go. */
  blocker: string | null
  importing: boolean
  /** Only a file in the connected folder can be refused for good. */
  isDriveFile: boolean
  onPrev: () => void
  onNext: () => void
  onShowFiles: () => void
  onImport: () => void
  onSkip: () => void
  onNeverOffer: (() => void) | null
  /** The AI-key button, when the deployment reads with the workspace's key. */
  children?: React.ReactNode
}) {
  const atStart = position <= 1
  const atEnd = position >= count

  // Paging is the reviewer's main movement, so the arrows work from anywhere
  // on the screen that is not a field — the document pane included. It listens
  // in the capture phase because the dialog the reviewer lives in stops
  // keydown from bubbling out of its panel, which is where focus starts;
  // `typingInto` is what keeps the keystroke with the field it belongs to.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return
      }
      if (typingInto(event.target)) return
      if (event.key === "ArrowLeft") {
        if (!atStart) onPrev()
      } else if (!atEnd) {
        onNext()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [atStart, atEnd, onPrev, onNext])

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border bg-card py-2">
      <span className="min-w-0 truncate text-md font-medium text-foreground">
        {title}
      </span>
      <span className="text-base text-muted-foreground">·</span>
      <span className="min-w-0 truncate text-base text-muted-foreground">
        {subtitle}
      </span>
      <span className="text-base text-muted-foreground">·</span>
      <span className="tabular text-base whitespace-nowrap text-muted-foreground">
        {position} of {count}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Previous receipt"
        disabled={atStart}
        onClick={onPrev}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Next receipt"
        disabled={atEnd}
        onClick={onNext}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" onClick={onShowFiles}>
        Files ({filesCount})
      </Button>
      {readingLabel ? (
        <span className="text-xs text-muted-foreground">{readingLabel}</span>
      ) : null}
      {children}

      <span className="ml-auto flex items-center gap-2">
        {blocker ? (
          <span className="text-xs text-muted-foreground">{blocker}</span>
        ) : null}
        {isDriveFile && onNeverOffer ? (
          <Button type="button" variant="ghost" onClick={onNeverOffer}>
            Never offer this file
          </Button>
        ) : null}
        <Button type="button" variant="ghost" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
        <Button
          type="button"
          disabled={busy || blocker !== null}
          pending={importing}
          onClick={onImport}
        >
          Import
        </Button>
      </span>
    </div>
  )
}
