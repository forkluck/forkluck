// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The Files screen: where receipts come from, and where the reviewer sends
 * the merchant back to. The refusals it prints are the ones that name the fix
 * — the phone setting, the size limit — so they are pinned here.
 */

const loadReadyDriveDocuments = vi.fn()
const skipDriveFiles = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  importInvoices: vi.fn(),
  checkDriveNow: vi.fn(),
  deleteInvoice: vi.fn(),
  loadReadyDriveDocuments: () => loadReadyDriveDocuments(),
  skipDriveFiles: (input: unknown) => skipDriveFiles(input),
  saveAnthropicKey: vi.fn(),
  deleteAnthropicKey: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  listSuppliers: () => Promise.resolve([]),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD", timezone: "UTC" }),
}))
vi.mock("@/components/invoices/document-viewer", () => ({
  // Rendering the document is the document viewer's own test; here it only
  // has to be something the reviewer can put in its left pane.
  DocumentViewer: () => <div data-testid="viewer" />,
}))
vi.mock("@/lib/google-drive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-drive")>()),
  openInvoicePicker: vi.fn(),
  downloadDriveFile: vi.fn(),
  preloadGoogleScripts: vi.fn(async () => {}),
}))

import { ImportFilesPanel } from "@/components/invoices/import-files-panel"
import { ImportInvoicesDialog } from "@/components/invoices/import-invoices-dialog"
import { downloadDriveFile, openInvoicePicker } from "@/lib/google-drive"

import { INGREDIENTS, parseResult, readyDocument } from "./receipt-fixture"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openDialog(inbox = false, drive = false) {
  render(
    <ImportInvoicesDialog
      config={
        drive ? { clientId: "test", apiKey: "test", appId: "test" } : null
      }
      driveConnectHref={null}
      ingredientsStatus="ready"
      onRetryIngredients={() => {}}
      ingredients={INGREDIENTS}
      open
      onOpenChange={vi.fn()}
      inbox={inbox}
      byok={false}
      aiKeyConfigured={false}
      aiKeyHint={null}
    />
  )
}

function drop(file: File) {
  const zone = screen.getByText("Drop invoice PDFs or receipt photos here")
    .parentElement as HTMLElement
  fireEvent.drop(zone, { dataTransfer: { files: [file] } })
}

async function chooseScan(source: "upload" | "drive", names = ["scan.pdf"]) {
  if (source === "upload") {
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: names.map(
          (name) =>
            new File(["synthetic pdf"], name, { type: "application/pdf" })
        ),
      },
    })
  } else {
    vi.mocked(openInvoicePicker).mockResolvedValue(
      names.map((name) => ({
        id: name,
        name,
        url: "https://drive.google.com/file/d/test",
        sizeBytes: 13,
        mimeType: "application/pdf",
      }))
    )
    vi.mocked(downloadDriveFile).mockResolvedValue({
      base64: "c3ludGhldGljIHBkZg==",
      bytes: 13,
      blob: new Blob(["synthetic pdf"], { type: "application/pdf" }),
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Import from Google Drive" })
    )
    await waitFor(() => expect(screen.queryByText("Opening Drive…")).toBeNull())
  }
}

async function showFiles() {
  const button = screen.queryByRole("button", { name: /^Files \(/ })
  if (button) fireEvent.click(button)
  await screen.findByText("Drop invoice PDFs or receipt photos here")
}

describe("the files screen refuses what the pipeline can't read", () => {
  it("offers a readable retry after a proxy error and accepts a streamed JSON result", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<!doctype html><h1>Unavailable</h1>", { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response("\n\n" + JSON.stringify({ documents: [parseResult()] }))
      )
    vi.stubGlobal("fetch", fetch)
    openDialog()
    drop(new File(["synthetic pdf"], "scan.pdf", { type: "application/pdf" }))

    await screen.findByText(
      "The connection ended before the receipt was ready. Nothing was imported. Please retry."
    )
    expect(screen.queryByText(/Unexpected token/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByText("1 of 1")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("offers Retry when the response stream ends before the result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("\n\n")))
    openDialog()
    drop(new File(["synthetic pdf"], "scan.pdf", { type: "application/pdf" }))
    await screen.findByText(
      "The connection ended before the receipt was ready. Nothing was imported. Please retry."
    )
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  })

  it("gives connection guidance when the upload request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    )
    openDialog()
    await chooseScan("upload")
    await screen.findByText(
      "The connection ended before the receipt was ready. Nothing was imported. Please retry."
    )
    expect(screen.queryByText("Failed to fetch")).toBeNull()
  })

  it.each(["upload", "drive"] as const)(
    "reselects a failed %s in place and clears old errors",
    async (source) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html>Unavailable</html>", { status: 503 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ documents: [parseResult()] }))
        )
      vi.stubGlobal("fetch", fetch)
      openDialog(false, source === "drive")
      await chooseScan(source)
      await screen.findByRole("button", { name: "Retry" })
      drop(new File(["csv"], "wrong.csv", { type: "text/csv" }))
      expect(screen.getByRole("alert").textContent).toContain("isn't a PDF")

      // Repeated selection in one gesture must enqueue only one retry.
      await chooseScan(source, ["scan.pdf", "scan.pdf"])
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      await showFiles()
      await screen.findByText("Parsed")
      expect(screen.getByText("1 file")).toBeTruthy()
      expect(screen.getAllByRole("listitem")).toHaveLength(1)
      expect(screen.queryByRole("alert")).toBeNull()
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    }
  )

  it("clears a stale batch error when Retry is pressed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html>Unavailable</html>", { status: 503 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ documents: [parseResult()] }))
        )
    )
    openDialog()
    await chooseScan("upload")
    await screen.findByRole("button", { name: "Retry" })
    drop(new File(["csv"], "wrong.csv", { type: "text/csv" }))
    expect(screen.getByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByText("1 of 1")
    await showFiles()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it.each(["upload", "drive"] as const)(
    "keeps queued, reading and completed %s files unique",
    async (source) => {
      const pending: Array<() => void> = []
      const fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(() =>
              resolve(
                new Response(JSON.stringify({ documents: [parseResult()] }))
              )
            )
          })
      )
      vi.stubGlobal("fetch", fetch)
      loadReadyDriveDocuments.mockResolvedValue({
        documents: [readyDocument(parseResult())],
        readyCount: 1,
        unreadable: 0,
      })
      openDialog(true, source === "drive")
      await screen.findByText("1 of 1")
      await showFiles()
      await chooseScan(source, [
        "scan.pdf",
        "two.pdf",
        "three.pdf",
        "queued.pdf",
      ])
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
      await showFiles()
      await chooseScan(source, ["scan.pdf", "queued.pdf"])
      await showFiles()
      expect(screen.queryByRole("alert")).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(screen.getAllByRole("listitem")).toHaveLength(5)

      await act(async () => {
        pending.splice(0).forEach((resolve) => resolve())
      })
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
      await act(async () => {
        pending.splice(0).forEach((resolve) => resolve())
      })
      await chooseScan(source)
      await showFiles()
      expect(screen.queryByRole("alert")).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(screen.getAllByRole("listitem")).toHaveLength(5)
    }
  )

  it("names the phone setting behind a HEIC photo", () => {
    openDialog()
    drop(new File(["heic"], "IMG_4021.HEIC", { type: "image/heic" }))
    expect(
      screen.getByText(
        "iPhone HEIC photos aren't supported — set Camera → Formats to Most Compatible, or share as JPEG."
      )
    ).toBeTruthy()
  })

  it("names the limit a too-large PDF passed", () => {
    openDialog()
    drop(
      new File([new Uint8Array(6_000_000)], "big.pdf", {
        type: "application/pdf",
      })
    )
    expect(screen.getByText("big.pdf is larger than 5 MB.")).toBeTruthy()
  })

  it("refuses anything that isn't a PDF or a photo", () => {
    openDialog()
    drop(new File(["a,b"], "orders.csv", { type: "text/csv" }))
    expect(screen.getByText("orders.csv isn't a PDF or a photo.")).toBeTruthy()
  })

  it("says how much of the inbox this sitting is showing", async () => {
    loadReadyDriveDocuments.mockResolvedValue({
      documents: [readyDocument(parseResult())],
      readyCount: 163,
      unreadable: 2,
    })
    openDialog(true)
    await screen.findByText("1 of 1")

    fireEvent.click(screen.getByRole("button", { name: "Files (1)" }))

    expect(
      screen.getByText(
        "Showing 1 of 163 — import these and open the inbox again. 2 stored reads couldn't be opened."
      )
    ).toBeTruthy()
  })
})

describe("a file the folder keeps handing back", () => {
  it("can be taken off the offer list from the queue row", () => {
    const onSkipQueued = vi.fn()
    const item = {
      key: "file-1",
      fileName: "linen-bill.pdf",
      source: "drive" as const,
      status: "error" as const,
      error: "Couldn't read that file.",
      driveFileId: "drive-9",
      driveWebViewLink: null,
      driveFetch: true,
      mediaType: "application/pdf" as const,
      file: null,
    }
    render(
      <ImportFilesPanel
        config={null}
        driveConnectHref={null}
        dragging={false}
        onDragging={vi.fn()}
        onUploads={vi.fn()}
        onDriveFiles={vi.fn()}
        onError={vi.fn()}
        reconnectNeeded={false}
        onReconnect={vi.fn()}
        queue={[item]}
        busyCount={0}
        onRetryQueued={vi.fn()}
        onSkipQueued={onSkipQueued}
        inboxNotice={null}
        error={null}
        busy={false}
        byok={false}
        aiKeyConfigured={false}
        aiKeyHint={null}
        reviewCount={0}
        onReview={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText("Couldn't read that file.")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Skip this file in future" })
    )
    expect(onSkipQueued).toHaveBeenCalledWith(item)
  })
})
