/**
 * Minimal ambient types for the two Google browser libraries the invoice
 * importer loads on demand (Google Identity Services + the Drive Picker).
 * Only the surface we actually call is typed.
 */

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}

interface GoogleTokenClientError {
  type?: string
  message?: string
}

interface GoogleTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void
}

interface GooglePickerDocument {
  id: string
  name?: string
  url?: string
  sizeBytes?: number
  mimeType?: string
}

interface GooglePickerResponse {
  action: string
  docs?: GooglePickerDocument[]
}

interface GooglePickerView {
  setMimeTypes(mimeTypes: string): GooglePickerView
  setIncludeFolders(include: boolean): GooglePickerView
}

interface GooglePickerInstance {
  setVisible(visible: boolean): void
  dispose(): void
}

interface GooglePickerBuilder {
  addView(view: GooglePickerView): GooglePickerBuilder
  enableFeature(feature: string): GooglePickerBuilder
  setDeveloperKey(key: string): GooglePickerBuilder
  setAppId(appId: string): GooglePickerBuilder
  setOAuthToken(token: string): GooglePickerBuilder
  setOrigin(origin: string): GooglePickerBuilder
  setTitle(title: string): GooglePickerBuilder
  setCallback(
    callback: (response: GooglePickerResponse) => void
  ): GooglePickerBuilder
  build(): GooglePickerInstance
}

interface GooglePickerNamespace {
  PickerBuilder: new () => GooglePickerBuilder
  DocsView: new (viewId?: string) => GooglePickerView
  ViewId: { PDFS: string; DOCS: string }
  Feature: { MULTISELECT_ENABLED: string }
  Action: { PICKED: string; CANCEL: string }
}

interface GoogleNamespace {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: GoogleTokenResponse) => void
        error_callback?: (error: GoogleTokenClientError) => void
      }): GoogleTokenClient
    }
  }
  picker: GooglePickerNamespace
}

declare const google: GoogleNamespace

interface Window {
  google?: GoogleNamespace
  gapi?: {
    load(name: string, callback: () => void): void
  }
}
