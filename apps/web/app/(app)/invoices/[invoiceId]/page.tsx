import { notFound } from "next/navigation"

import { listExpenseCategories } from "@/app/(app)/invoices/actions"
import { listSuppliers } from "@/app/(app)/settings/actions"
import { DocumentViewer } from "@/components/invoices/document-viewer"
import { InvoiceChrome } from "@/components/invoices/invoice-chrome"
import { InvoiceActivity } from "@/components/invoices/invoice-activity"
import { InvoiceEditor } from "@/components/invoices/invoice-editor"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import {
  getIngredientOptions,
  getInvoice,
  getPaymentMethods,
} from "@/lib/backend/queries"
import { invoiceListHref } from "@/lib/invoice-navigation"

/** What the document pane draws with, from the name the file was saved under.
 * Anything else was never kept as a document. */
function documentMediaType(fileName: string) {
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf(".") + 1)
  switch (extension) {
    case "pdf":
      return "application/pdf" as const
    case "jpg":
    case "jpeg":
      return "image/jpeg" as const
    case "png":
      return "image/png" as const
    case "webp":
      return "image/webp" as const
    default:
      return null
  }
}

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { invoiceId } = await params
  const { returnTo } = await searchParams
  const [user, invoice, suppliers, ingredients, categories, paymentMethods] =
    await Promise.all([
      requireUser(),
      getInvoice(invoiceId),
      listSuppliers(),
      getIngredientOptions(),
      listExpenseCategories(),
      getPaymentMethods(),
    ])
  if (!invoice) notFound()

  const hasDocument = Boolean(invoice.driveFileId || invoice.documentKey)
  // A stored key ends in the extension the store gave it; a Drive file only
  // has the name Drive reported.
  const mediaType = hasDocument
    ? documentMediaType(invoice.documentKey ?? invoice.fileName)
    : null
  const part = invoice.driveFilePart
  const editor = (
    <>
      {/* Filing a line is a write of its own, outside the document's save.
          Keying on how many lines still need one remounts the editor after
          that write lands, so its baseline is what the server now holds. */}
      <InvoiceEditor
        key={invoice.lines.filter((line) => line.needsReview).length}
        initial={invoice}
        supplierNames={suppliers.map((supplier) => supplier.name)}
        ingredients={ingredients}
        categories={categories}
        paymentMethods={paymentMethods}
        currentUserId={user.id}
      />
      <InvoiceActivity resourceId={invoice.id} />
    </>
  )

  return (
    // Beside a document the page takes the whole viewport, as the reviewer
    // does: the 1280px column would leave both panes too narrow to read.
    <Page variant={hasDocument && mediaType ? "wide" : "centered"}>
      <InvoiceChrome
        title={invoice.invoiceNumber || invoice.supplierName}
        id={invoice.id}
        publicId={invoice.publicId}
        driveWebViewLink={invoice.driveWebViewLink || undefined}
        listHref={invoiceListHref(returnTo)}
      >
        {hasDocument && mediaType ? (
          // The document beside its lines, as in the reviewer. The pane is as
          // tall as the lines beside it and scrolls inside when the document
          // runs longer; nothing sticks or follows the scroll.
          <div className="grid gap-6 xl:grid-cols-[minmax(388px,2fr)_minmax(732px,3fr)]">
            <div className="h-[70dvh] min-h-0 xl:h-auto">
              <DocumentViewer
                source={{
                  file: null,
                  driveFileId: invoice.driveFileId,
                  documentKey: invoice.documentKey,
                  mediaType,
                  fileName: invoice.fileName,
                }}
                boxes={[]}
                pages={
                  part && part.pageStart !== null && part.pageEnd !== null
                    ? { start: part.pageStart, end: part.pageEnd }
                    : null
                }
                region={part?.region ?? null}
                selectedKey={null}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-5">{editor}</div>
          </div>
        ) : (
          editor
        )}
      </InvoiceChrome>
    </Page>
  )
}
