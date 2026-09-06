import { redirect } from "next/navigation"

/** The Sales family opens on its Connections child. */
export default function SalesIntegrationsPage() {
  redirect("/integrations/sales/connections")
}
