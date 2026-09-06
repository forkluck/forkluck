"use client"

import * as React from "react"
import { Minus, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { InvoiceDocument } from "@/components/invoices/receipt-state"
import type { LineBox } from "@/lib/invoice-import"
import { cn } from "@/lib/utils"

/** A line's box plus the name to announce it by. */
export type DocumentBox = { key: string; box: LineBox; label?: string }

/** The pages of a PDF one document occupies, 0-based and inclusive. */
export type PageRange = { start: number; end: number }

/** The corner of a photo one document occupies, as fractions of the image. */
export type PhotoRegion = { x0: number; y0: number; x1: number; y1: number }

type PdfDocument = Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>

/** A page proxy with the size it renders at scale 1, so the wrapper can be
 * sized before the canvas has painted anything. */
type LoadedPage = { proxy: PdfPage; width: number; height: number }

/** A finished read of one document; `pages: null` is the read that failed. */
type Load = {
  file: File | null
  url: string | null
  pages: LoadedPage[] | null
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const ZOOM_STEP = 1.25

/**
 * The document beside the lines read from it, with a box drawn over the part
 * of the page each line came from.
 *
 * A PDF is rendered page by page onto its own canvas — an iframe cannot be
 * drawn on, and the whole point here is drawing on it. Pages paint lazily and
 * a render in flight is cancelled when its page scrolls away or the zoom
 * changes. Boxes are positioned in percent inside the page wrapper, so zoom
 * moves the page and the boxes together without any recalculation.
 */
export function DocumentViewer({
  source,
  boxes,
  pages = null,
  region = null,
  selectedKey,
  onSelect,
}: {
  source: InvoiceDocument
  boxes: DocumentBox[]
  /** Show only these pages — one document out of a scanned bundle. Null is the
   * whole file. A box keeps the page number it has in the whole file. */
  pages?: PageRange | null
  /** Outline this corner of the photo — one receipt out of a photographed
   * pile. Null is the whole photo. */
  region?: PhotoRegion | null
  selectedKey: string | null
  onSelect?: (key: string) => void
}) {
  return source.mediaType === "application/pdf" ? (
    <PdfViewer
      source={source}
      boxes={boxes}
      range={pages}
      selectedKey={selectedKey}
      onSelect={onSelect}
    />
  ) : (
    <PhotoViewer
      source={source}
      boxes={boxes}
      region={region}
      selectedKey={selectedKey}
      onSelect={onSelect}
    />
  )
}

/** Both shapes read the same sources: bytes the browser already holds, a file
 * that only lives in the connected folder, or one we stored at import time. */
function documentUrl(source: InvoiceDocument) {
  if (source.driveFileId) {
    return `/api/invoices/drive-file?id=${encodeURIComponent(source.driveFileId)}`
  }
  if (source.documentKey) {
    return `/api/invoices/document?key=${encodeURIComponent(source.documentKey)}`
  }
  return null
}

function PhotoViewer({
  source,
  boxes,
  region,
  selectedKey,
  onSelect,
}: {
  source: InvoiceDocument
  boxes: DocumentBox[]
  region: PhotoRegion | null
  selectedKey: string | null
  onSelect?: (key: string) => void
}) {
  const file = source.file
  const objectUrl = React.useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  )
  // Whatever the last render minted is what gets released, so a re-mint frees
  // the one it replaced instead of leaking it.
  React.useEffect(() => {
    if (!objectUrl) return
    return () => URL.revokeObjectURL(objectUrl)
  }, [objectUrl])

  const url = objectUrl ?? documentUrl(source)
  if (!url) return null

  return (
    <Frame>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={source.fileName} className="block w-full" />
        {region ? <RegionMask region={region} /> : null}
        <BoxOverlay
          boxes={boxes.filter((entry) => entry.box.page === 0)}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      </div>
    </Frame>
  )
}

function PdfViewer({
  source,
  boxes,
  range,
  selectedKey,
  onSelect,
}: {
  source: InvoiceDocument
  boxes: DocumentBox[]
  range: PageRange | null
  selectedKey: string | null
  onSelect?: (key: string) => void
}) {
  // The load is stamped with the bytes it came from, so a switch to another
  // receipt reads as "loading" straight away rather than showing the previous
  // document's pages until the new ones arrive.
  const [load, setLoad] = React.useState<Load | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pageRefs = React.useRef<(HTMLDivElement | null)[]>([])
  const [currentPage, setCurrentPage] = React.useState(0)
  // null means "fit the width", which is where the viewer opens.
  const [zoom, setZoom] = React.useState<number | null>(null)
  const [fitZoom, setFitZoom] = React.useState(1)

  const file = source.file
  const url = documentUrl(source)
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const bytes = file
          ? await file.arrayBuffer()
          : await (async () => {
              if (!url) throw new Error("no document")
              const response = await fetch(url)
              if (!response.ok) throw new Error("document unavailable")
              return await response.arrayBuffer()
            })()
        const { getDocumentProxy } = await import("unpdf")
        const pdf = await getDocumentProxy(new Uint8Array(bytes))
        const loaded: LoadedPage[] = []
        for (let number = 1; number <= pdf.numPages; number += 1) {
          const proxy = await pdf.getPage(number)
          const viewport = proxy.getViewport({ scale: 1 })
          loaded.push({
            proxy,
            width: viewport.width,
            height: viewport.height,
          })
        }
        if (!cancelled) setLoad({ file, url, pages: loaded })
      } catch {
        if (!cancelled) setLoad({ file, url, pages: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file, url])

  const loaded = load && load.file === file && load.url === url ? load : null
  const all = loaded?.pages ?? null
  const failed = loaded !== null && loaded.pages === null

  // One document out of a scanned bundle is a page range of the file it was
  // scanned in; the pages on either side belong to another receipt and are not
  // drawn. Page numbers stay the file's own, so a box needs no offset.
  const first = all && range ? Math.max(0, range.start) : 0
  const pages =
    all &&
    all.slice(first, range ? Math.min(all.length, range.end + 1) : all.length)

  // Fit-to-width follows the pane, so a resized dialog keeps filling it.
  const widest = pages?.reduce((most, page) => Math.max(most, page.width), 0)
  React.useEffect(() => {
    const root = scrollRef.current
    if (!root || !widest) return
    const measure = () => {
      const available = root.clientWidth - 24
      if (available > 0) setFitZoom(available / widest)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [widest])

  const scale = zoom ?? fitZoom

  // Scroll to the selected line's page, but only when the selection moved —
  // otherwise the viewer fights the reader's own scrolling.
  const selectedPage = selectedKey
    ? (boxes.find((entry) => entry.key === selectedKey)?.box.page ?? null)
    : null
  React.useEffect(() => {
    if (selectedPage === null) return
    pageRefs.current[selectedPage]?.scrollIntoView({ block: "nearest" })
  }, [selectedPage, selectedKey])

  function handleScroll() {
    const root = scrollRef.current
    if (!root) return
    const top = root.getBoundingClientRect().top
    const index = pageRefs.current.findIndex(
      (element) => element && element.getBoundingClientRect().bottom > top + 24
    )
    setCurrentPage(index < 0 ? Math.max(pageRefs.current.length - 1, 0) : index)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={!pages}
          onClick={() =>
            setZoom(Math.max(MIN_ZOOM, Number((scale / ZOOM_STEP).toFixed(4))))
          }
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={!pages}
          onClick={() =>
            setZoom(Math.min(MAX_ZOOM, Number((scale * ZOOM_STEP).toFixed(4))))
          }
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="default"
          disabled={!pages}
          onClick={() => setZoom(null)}
        >
          Fit
        </Button>
        {pages ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {Math.min(Math.max(currentPage - first, 0), pages.length - 1) + 1} /{" "}
            {pages.length}
          </span>
        ) : null}
      </div>
      <Frame ref={scrollRef} onScroll={handleScroll}>
        {failed ? (
          <p className="p-6 text-xs text-muted-foreground">
            Couldn&apos;t open this document.
          </p>
        ) : !pages ? (
          <p className="p-6 text-xs text-muted-foreground">Loading document…</p>
        ) : (
          <div className="flex flex-col items-center gap-3 p-3">
            {pages.map((page, offset) => {
              const index = first + offset
              return (
                <PdfPageView
                  key={index}
                  ref={(element) => {
                    pageRefs.current[index] = element
                  }}
                  page={page}
                  scale={scale}
                  boxes={boxes.filter((entry) => entry.box.page === index)}
                  selectedKey={selectedKey}
                  onSelect={onSelect}
                />
              )
            })}
          </div>
        )}
      </Frame>
    </div>
  )
}

/**
 * One page: a canvas sized in CSS to the zoomed page and backed by a bitmap at
 * the device's pixel ratio, plus the boxes that landed on it. It paints only
 * once it is near the viewport, and a paint still running when the page leaves
 * or the zoom changes is cancelled rather than left to finish into a canvas
 * nobody is looking at.
 */
function PdfPageView({
  ref,
  page,
  scale,
  boxes,
  selectedKey,
  onSelect,
}: {
  ref: (element: HTMLDivElement | null) => void
  page: LoadedPage
  scale: number
  boxes: DocumentBox[]
  selectedKey: string | null
  onSelect?: (key: string) => void
}) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  // jsdom has no IntersectionObserver, and neither does a print render: with
  // no way to tell what is near the viewport, every page paints.
  const [near, setNear] = React.useState(
    typeof IntersectionObserver === "undefined"
  )

  React.useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      // Two pages ahead in either direction.
      { rootMargin: "200% 0px" }
    )
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!near || !canvas) return
    const context = canvas.getContext("2d")
    if (!context) return
    const ratio = window.devicePixelRatio || 1
    const viewport = page.proxy.getViewport({ scale: scale * ratio })
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const task = page.proxy.render({ canvas, canvasContext: context, viewport })
    // A cancelled task rejects; that is the expected end of a page that
    // scrolled away, not a failure to report.
    task.promise.catch(() => {})
    return () => task.cancel()
  }, [near, page, scale])

  return (
    <div
      ref={(element) => {
        wrapperRef.current = element
        ref(element)
      }}
      data-slot="pdf-page"
      className="relative shrink-0 border border-border bg-card"
      style={{ width: page.width * scale, height: page.height * scale }}
    >
      {near ? <canvas ref={canvasRef} className="block size-full" /> : null}
      <BoxOverlay boxes={boxes} selectedKey={selectedKey} onSelect={onSelect} />
    </div>
  )
}

/**
 * Which corner of the photo this receipt is: outlined, with the rest of the
 * photo — the other receipts in the pile — dimmed behind four panels. Nothing
 * in this design casts a shadow, so the dimming is drawn rather than cast.
 */
function RegionMask({ region }: { region: PhotoRegion }) {
  const percent = (value: number) => `${value * 100}%`
  const dim = "pointer-events-none absolute bg-foreground/28"
  return (
    <>
      <div
        className={dim}
        style={{ left: 0, right: 0, top: 0, height: percent(region.y0) }}
      />
      <div
        className={dim}
        style={{ left: 0, right: 0, top: percent(region.y1), bottom: 0 }}
      />
      <div
        className={dim}
        style={{
          left: 0,
          top: percent(region.y0),
          width: percent(region.x0),
          height: percent(region.y1 - region.y0),
        }}
      />
      <div
        className={dim}
        style={{
          left: percent(region.x1),
          right: 0,
          top: percent(region.y0),
          height: percent(region.y1 - region.y0),
        }}
      />
      <div
        data-slot="document-region"
        className="pointer-events-none absolute rounded-sm border-2 border-brand"
        style={{
          left: percent(region.x0),
          top: percent(region.y0),
          width: percent(region.x1 - region.x0),
          height: percent(region.y1 - region.y0),
        }}
      />
    </>
  )
}

/** The boxes over one page. Percent keeps them in place through every zoom. */
function BoxOverlay({
  boxes,
  selectedKey,
  onSelect,
}: {
  boxes: DocumentBox[]
  selectedKey: string | null
  onSelect?: (key: string) => void
}) {
  return boxes.map(({ key, box, label }) => {
    const selected = key === selectedKey
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        aria-label={label ?? "Line on this page"}
        data-slot="document-box"
        data-selected={selected || undefined}
        onClick={() => onSelect?.(key)}
        className={cn(
          "absolute before:pointer-events-none before:absolute before:-inset-x-1 before:-inset-y-0.5 before:rounded-sm before:border-2 before:border-transparent",
          selected
            ? "before:border-brand before:bg-brand-fill/45"
            : "hover:before:border-brand/40 hover:before:bg-brand-fill/20"
        )}
        style={{
          left: `${box.x0 * 100}%`,
          top: `${box.y0 * 100}%`,
          width: `${(box.x1 - box.x0) * 100}%`,
          height: `${(box.y1 - box.y0) * 100}%`,
        }}
      />
    )
  })
}

/** The scrolling surface the document sits on. */
function Frame({
  ref,
  onScroll,
  children,
}: {
  ref?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  children: React.ReactNode
}) {
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-fill-soft"
    >
      {children}
    </div>
  )
}
