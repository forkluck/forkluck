import type { Metadata } from "next"

import { listExpenseCategories } from "@/app/(app)/invoices/actions"
import { listSuppliers } from "@/app/(app)/settings/actions"
import { InvoiceChrome } from "@/components/invoices/invoice-chrome"
import { InvoiceEditor } from "@/components/invoices/invoice-editor"
import { Page } from "@/components/ui/page"
import { requireUser } from "@/lib/auth-session"
import { getIngredientOptions, getPaymentMethods } from "@/lib/backend/queries"

export const metadata: Metadata = { title: "New invoice" }

export default async function NewInvoicePage() {
  const [user, suppliers, ingredients, categories, paymentMethods] =
    await Promise.all([
      requireUser(),
      listSuppliers(),
      getIngredientOptions(),
      listExpenseCategories(),
      getPaymentMethods(),
    ])

  return (
    <Page>
      <InvoiceChrome title="New invoice">
        <InvoiceEditor
          initial={null}
          supplierNames={suppliers.map((supplier) => supplier.name)}
          ingredients={ingredients}
          categories={categories}
          paymentMethods={paymentMethods}
          currentUserId={user.id}
        />
      </InvoiceChrome>
    </Page>
  )
}
