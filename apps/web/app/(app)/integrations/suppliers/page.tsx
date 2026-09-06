import { redirect } from "next/navigation"

/** The Suppliers family opens on its Connections child. */
export default function SuppliersIntegrationsPage() {
  redirect("/integrations/suppliers/connections")
}
