/**
 * Client-side Google Drive access for the invoice importer: Google Identity
 * Services token client + Drive Picker on the non-sensitive `drive.file`
 * scope, with the browser downloading picked PDFs straight from
 * googleapis.com (CORS is supported — no server proxy, and the server never
 * sees a Google token). All three config values are public by design; the
 * origin/referrer restrictions on them are the protection.
 */

import { readAsBase64 } from "./client-file"

export type GoogleDriveConfig = {
  clientId: string
  apiKey: string
  appId: string
}

export type PickedDriveFile = {
  id: string
  name: string
  url: string
  sizeBytes: number | null
  mimeType: string
}

export type GoogleDriveErrorCode =
  "popup_blocked" | "cancelled" | "unauthorized" | "error"

export class GoogleDriveError extends Error {
  code: GoogleDriveErrorCode

  constructor(code: GoogleDriveErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const GSI_SRC = "https://accounts.google.com/gsi/client"
const GAPI_SRC = "https://apis.google.com/js/api.js"

const scriptPromises = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = scriptPromises.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      scriptPromises.delete(src)
      reject(new GoogleDriveError("error", `Couldn't load ${src}`))
    }
    document.head.appendChild(script)
  })
  scriptPromises.set(src, promise)
  return promise
}

let pickerLoaded: Promise<void> | null = null

/** Loads both Google scripts; call on dialog open so they're warm before the
 * user clicks the Drive button. */
export function preloadGoogleScripts(): Promise<void> {
  if (pickerLoaded) return pickerLoaded
  pickerLoaded = (async () => {
    await Promise.all([loadScript(GSI_SRC), loadScript(GAPI_SRC)])
    await new Promise<void>((resolve) => {
      window.gapi?.load("picker", resolve)
    })
  })()
  pickerLoaded.catch(() => {
    pickerLoaded = null
  })
  return pickerLoaded
}

let cachedToken: { token: string; expiresAt: number } | null = null

export function invalidateDriveToken(): void {
  cachedToken = null
}

/**
 * GIS token model: a short-lived access token, no refresh tokens and nothing
 * stored server-side. Must be called from a user gesture the first time —
 * Google may open a consent popup.
 */
export async function getDriveAccessToken(clientId: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token
  }
  await preloadGoogleScripts()
  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (!response.access_token) {
          reject(
            new GoogleDriveError("error", response.error ?? "No access token")
          )
          return
        }
        cachedToken = {
          token: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        }
        resolve(response.access_token)
      },
      error_callback: (error) => {
        if (error.type === "popup_failed_to_open") {
          reject(
            new GoogleDriveError(
              "popup_blocked",
              "Allow popups for this site and try again."
            )
          )
        } else if (error.type === "popup_closed") {
          reject(new GoogleDriveError("cancelled", "Sign-in was cancelled."))
        } else {
          reject(
            new GoogleDriveError(
              "error",
              error.message ?? "Google sign-in failed."
            )
          )
        }
      },
    })
    client.requestAccessToken()
  })
}

/**
 * Opens the Picker filtered to PDFs with folders navigable (with drive.file,
 * picking a folder wouldn't grant access to its children — users open the
 * month folder and multi-select the PDFs inside). Resolves with [] on cancel.
 */
export async function openInvoicePicker(
  config: GoogleDriveConfig
): Promise<PickedDriveFile[]> {
  const token = await getDriveAccessToken(config.clientId)
  await preloadGoogleScripts()
  return new Promise<PickedDriveFile[]>((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.PDFS)
      .setMimeTypes("application/pdf")
      .setIncludeFolders(true)
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOAuthToken(token)
      .setOrigin(window.location.origin)
      .setTitle("Select invoice PDFs")
      .setCallback((response) => {
        if (response.action === google.picker.Action.PICKED) {
          picker.dispose()
          resolve(
            (response.docs ?? []).map((doc) => ({
              id: doc.id,
              name: doc.name ?? "invoice.pdf",
              url: doc.url ?? `https://drive.google.com/file/d/${doc.id}/view`,
              sizeBytes: doc.sizeBytes ?? null,
              mimeType: doc.mimeType ?? "",
            }))
          )
        } else if (response.action === google.picker.Action.CANCEL) {
          picker.dispose()
          resolve([])
        }
      })
      .build()
    picker.setVisible(true)
  })
}

/** Downloads one picked PDF straight from Drive into raw base64 (no data:
 * prefix — the same shape the drag-and-drop path produces). */
export async function downloadDriveFile(
  fileId: string,
  clientId: string
): Promise<{ base64: string; bytes: number; blob: Blob }> {
  const token = await getDriveAccessToken(clientId)
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (response.status === 401 || response.status === 403) {
    invalidateDriveToken()
    throw new GoogleDriveError(
      "unauthorized",
      "Google Drive access expired — reconnect and retry."
    )
  }
  if (!response.ok) {
    throw new GoogleDriveError(
      "error",
      `Drive download failed (${response.status}).`
    )
  }
  const blob = await response.blob()
  // The blob comes back too: the review pane shows the document from an
  // object URL rather than downloading the same file a second time.
  return { base64: await readAsBase64(blob), bytes: blob.size, blob }
}
