// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The document shown beside the lines read from it, with a box over the part
 * of the page each line came from.
 *
 * A PDF is painted page by page onto canvases this component owns — that is
 * what lets it draw the boxes — so pdf.js is mocked here down to the two
 * calls the viewer makes of it: the viewport that sizes a page, and the render
 * task that fills it.
 */

const render1 = { promise: Promise.resolve(), cancel: vi.fn() }
const getViewport = vi.fn(() => ({ width: 612, height: 792 }))
const renderPage = vi.fn(() => render1)
/** How long the file is; a bundle is longer than the receipt being reviewed. */
let numPages = 2

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({
    numPages,
    getPage: vi.fn(async () => ({ getViewport, render: renderPage })),
  })),
}))

import { DocumentViewer } from "@/components/invoices/document-viewer"

const pdfSource = {
  file: new File(["%PDF"], "invoice.pdf", { type: "application/pdf" }),
  driveFileId: null,
  documentKey: null,
  mediaType: "application/pdf" as const,
  fileName: "invoice.pdf",
}

const boxes = [
  { key: "line-1", box: { page: 0, x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.25 } },
  { key: "line-2", box: { page: 1, x0: 0, y0: 0, x1: 1, y1: 0.1 } },
]

function pageWrappers() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="pdf-page"]')
  )
}

async function renderPdf(
  props: Partial<Parameters<typeof DocumentViewer>[0]>,
  shown = 2
) {
  const view = render(
    <DocumentViewer
      source={pdfSource}
      boxes={boxes}
      selectedKey={null}
      {...props}
    />
  )
  await waitFor(() => expect(pageWrappers()).toHaveLength(shown))
  return view
}

beforeEach(() => {
  numPages = 2
  URL.createObjectURL = vi.fn(() => "blob:receipt-1")
  URL.revokeObjectURL = vi.fn()
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}) as never)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

describe("DocumentViewer", () => {
  it("draws every page at its own aspect and counts them", async () => {
    await renderPdf({})

    for (const wrapper of pageWrappers()) {
      expect(wrapper.style.width).toBe("612px")
      expect(wrapper.style.height).toBe("792px")
    }
    expect(screen.getByText("1 / 2")).toBeTruthy()
  })

  it("zooms the pages in and out and back to the fitted width", async () => {
    await renderPdf({})

    fireEvent.click(screen.getByLabelText("Zoom in"))
    expect(pageWrappers()[0].style.width).toBe("765px")

    fireEvent.click(screen.getByLabelText("Zoom out"))
    expect(pageWrappers()[0].style.width).toBe("612px")

    fireEvent.click(screen.getByLabelText("Zoom in"))
    fireEvent.click(screen.getByRole("button", { name: "Fit" }))
    expect(pageWrappers()[0].style.width).toBe("612px")
  })

  it("puts each box on its own page in percent", async () => {
    await renderPdf({})

    const [first, second] = pageWrappers()
    const box = first.querySelector<HTMLElement>('[data-slot="document-box"]')
    expect(box?.style.left).toBe("10%")
    expect(box?.style.top).toBe("20%")
    expect(box?.style.width).toBe("50%")
    expect(Number.parseFloat(box!.style.height)).toBeCloseTo(5)
    expect(second.querySelectorAll('[data-slot="document-box"]')).toHaveLength(
      1
    )
  })

  it("reports the line a box belongs to and marks the selected one", async () => {
    const onSelect = vi.fn()
    const view = await renderPdf({ onSelect })

    const box = pageWrappers()[0].querySelector<HTMLElement>(
      '[data-slot="document-box"]'
    )!
    fireEvent.click(box)
    expect(onSelect).toHaveBeenCalledWith("line-1")

    expect(box.dataset.selected).toBeUndefined()
    view.rerender(
      <DocumentViewer source={pdfSource} boxes={boxes} selectedKey="line-1" />
    )
    const selected = pageWrappers()[0].querySelector<HTMLElement>(
      '[data-slot="document-box"]'
    )!
    expect(selected.dataset.selected).toBe("true")
    expect(selected.className).toContain("border-brand")
  })

  it("scrolls the selected line's page into view", async () => {
    const view = await renderPdf({})
    view.rerender(
      <DocumentViewer source={pdfSource} boxes={boxes} selectedKey="line-2" />
    )
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
      })
    )
  })

  it("shows a photo as an image under the same boxes", () => {
    const view = render(
      <DocumentViewer
        source={{
          file: new File(["jpeg"], "receipt.jpg", { type: "image/jpeg" }),
          driveFileId: null,
          documentKey: null,
          mediaType: "image/jpeg",
          fileName: "receipt.jpg",
        }}
        boxes={boxes}
        selectedKey="line-1"
      />
    )
    const image = view.container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("blob:receipt-1")
    expect(image?.getAttribute("alt")).toBe("receipt.jpg")
    // Only the box on the first page belongs to a photo.
    const drawn = view.container.querySelectorAll<HTMLElement>(
      '[data-slot="document-box"]'
    )
    expect(drawn).toHaveLength(1)
    expect(drawn[0].style.left).toBe("10%")
    expect(drawn[0].dataset.selected).toBe("true")
  })

  it("shows only the pages one receipt of a bundle was scanned on", async () => {
    numPages = 4
    await renderPdf(
      {
        pages: { start: 1, end: 2 },
        boxes: [
          { key: "line-3", box: { page: 2, x0: 0, y0: 0.5, x1: 1, y1: 0.6 } },
        ],
      },
      2
    )

    // Two of the four, counted within the receipt rather than the file.
    expect(screen.getByText("1 / 2")).toBeTruthy()
    // The box keeps the page number it has in the whole file: page 2 is the
    // second page drawn here.
    const [first, second] = pageWrappers()
    expect(first.querySelectorAll('[data-slot="document-box"]')).toHaveLength(0)
    expect(second.querySelectorAll('[data-slot="document-box"]')).toHaveLength(
      1
    )
  })

  it("outlines the corner of a photo one receipt sits in", () => {
    const view = render(
      <DocumentViewer
        source={{
          file: new File(["jpeg"], "IMG_1584.JPG", { type: "image/jpeg" }),
          driveFileId: null,
          documentKey: null,
          mediaType: "image/jpeg",
          fileName: "IMG_1584.JPG",
        }}
        boxes={[]}
        region={{ x0: 0.5, y0: 0.2, x1: 1, y1: 0.6 }}
        selectedKey={null}
      />
    )
    const outline = view.container.querySelector<HTMLElement>(
      '[data-slot="document-region"]'
    )!
    expect(outline.style.left).toBe("50%")
    expect(outline.style.top).toBe("20%")
    expect(outline.style.width).toBe("50%")
    expect(Number.parseFloat(outline.style.height)).toBeCloseTo(40)
    expect(outline.className).toContain("border-brand")
  })

  it("streams a stored photo from the document route", () => {
    const view = render(
      <DocumentViewer
        source={{
          file: null,
          driveFileId: null,
          documentKey: "user-1/abc def.jpg",
          mediaType: "image/jpeg",
          fileName: "receipt.jpg",
        }}
        boxes={[]}
        selectedKey={null}
      />
    )
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/invoices/document?key=user-1%2Fabc%20def.jpg"
    )
  })

  it("says so when the document cannot be opened", async () => {
    const view = render(
      <DocumentViewer
        source={{
          file: null,
          driveFileId: null,
          documentKey: null,
          mediaType: "application/pdf",
          fileName: "IV101.pdf",
        }}
        boxes={[]}
        selectedKey={null}
      />
    )
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Couldn't open this document."
      )
    )
  })
})
