"use client"

import * as React from "react"
import { HardDriveDownload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  GoogleDriveError,
  openInvoicePicker,
  preloadGoogleScripts,
  type GoogleDriveConfig,
  type PickedDriveFile,
} from "@/lib/google-drive"

/**
 * "Import from Google Drive" button: one user gesture drives the GIS token
 * popup (first time only) and then the Picker. The parent decides what to do
 * with the picked files; rendering nothing when Drive isn't configured keeps
 * drag-and-drop as the universal fallback.
 */
export function GoogleDrivePickerButton({
  config,
  disabled,
  onFiles,
  onError,
}: {
  config: GoogleDriveConfig | null
  disabled: boolean
  onFiles: (files: PickedDriveFile[]) => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (config) void preloadGoogleScripts().catch(() => {})
  }, [config])

  if (!config) return null

  const pick = async () => {
    setBusy(true)
    try {
      const files = await openInvoicePicker(config)
      if (files.length > 0) onFiles(files)
    } catch (error) {
      if (error instanceof GoogleDriveError) {
        if (error.code !== "cancelled") onError(error.message)
      } else {
        onError("Couldn't open Google Drive — try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || busy}
      onClick={() => void pick()}
    >
      {/* 14px glyph, the size every button icon in the handoff is drawn at. */}
      <HardDriveDownload strokeWidth={1.8} aria-hidden="true" />
      {busy ? "Opening Drive…" : "Import from Google Drive"}
    </Button>
  )
}
