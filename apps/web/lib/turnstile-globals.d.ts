/**
 * Minimal ambient types for Cloudflare Turnstile, which the signup form loads
 * on demand. Only the surface we call is typed.
 */

interface TurnstileRenderOptions {
  sitekey: string
  action?: string
  theme?: "auto" | "light" | "dark"
  size?: "normal" | "flexible" | "compact"
  callback?: (token: string) => void
  "expired-callback"?: () => void
  "error-callback"?: () => void
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: TurnstileRenderOptions
  ): string | undefined
  reset(widgetId: string): void
  remove(widgetId: string): void
  getResponse(widgetId: string): string | undefined
}

interface Window {
  turnstile?: TurnstileApi
}
