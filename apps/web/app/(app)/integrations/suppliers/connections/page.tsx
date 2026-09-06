import type { Metadata } from "next"

import {
  DriveFileLists,
  DriveFolderRow,
} from "@/components/settings/drive-folder-row"
import { SupplierConnectorCatalog } from "@/components/settings/supplier-connector-catalog"
import { requireUser } from "@/lib/auth-session"
import {
  getDriveFiles,
  getDriveFolder,
  getInvoicesOverview,
} from "@/lib/backend/queries"

export const metadata: Metadata = { title: "Connections" }

/** Where supplier documents come from, as one list: the Drive folder first,
 * then each supplier connector. */
export default async function SuppliersConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  // Connector callback values are short-lived and consumed by the client
  // component exactly once. Only scalar state/code values are accepted.
  const query = await searchParams
  const callback = {
    state: typeof query.state === "string" ? query.state : null,
    code: typeof query.code === "string" ? query.code : null,
    error:
      typeof query.connector_error === "string" ||
      typeof query.error === "string" ||
      typeof query.error_description === "string"
        ? "provider_error"
        : null,
  }
  // Connector catalog status travels with the invoice overview so this page
  // and the invoice import controls can agree on one tenant-scoped snapshot.
  const [overview, drive, failed] = await Promise.all([
    getInvoicesOverview(),
    getDriveFolder(),
    getDriveFiles("failed", 20),
  ])

  return (
    <div className="max-w-[760px]">
      <div className="overflow-hidden rounded-xl border border-border">
        {/* Server-only credential: only the address to share with is rendered. */}
        <DriveFolderRow
          folder={drive.folder}
          watch={drive.watch}
          readyCount={overview.driveReadyCount}
          newCount={overview.driveNewCount}
          serviceAccountEmail={process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null}
        />
        <SupplierConnectorCatalog
          connectors={overview.connectors}
          callback={callback}
        />
      </div>
      {drive.folder ? (
        <DriveFileLists failed={failed.files} skipped={drive.skipped} />
      ) : null}
    </div>
  )
}
