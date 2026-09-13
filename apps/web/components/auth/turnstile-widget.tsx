"use client"

import * as React from "react"

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

let scriptPromise: Promise<TurnstileApi> | null = null

/** Loads Cloudflare's script once per page. The promise is shared by every
 * widget and dropped on failure so a later mount can try again. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error("Turnstile did not initialise"))
    }
    script.onerror = () => {
      scriptPromise = null
      reject(new Error("Couldn't load Turnstile"))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/**
 * Cloudflare's bot check on the signup form. In the dashboard's invisible
 * mode it shows a visitor nothing. It hands `onToken` a single-use token, and
 * null when that token expired or the check failed, so the form waits for the
 * next one instead of sending a spent token. Bumping `resetSignal` after a
 * failed submit asks for a fresh token.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetSignal = 0,
}: {
  siteKey: string
  onToken: (token: string | null) => void
  resetSignal?: number
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const widgetId = React.useRef<string | null>(null)

  React.useEffect(() => {
    const node = container.current
    if (!node) return
    // Strict Mode mounts twice; the flag keeps the first, cancelled mount from
    // rendering a second widget into the same container once the script lands.
    let cancelled = false
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled) return
        widgetId.current =
          turnstile.render(node, {
            sitekey: siteKey,
            action: "signup",
            callback: (token) => onToken(token),
            "expired-callback": () => onToken(null),
            "error-callback": () => onToken(null),
          }) ?? null
      },
      () => {
        if (!cancelled) onToken(null)
      }
    )
    return () => {
      cancelled = true
      const id = widgetId.current
      widgetId.current = null
      if (id) window.turnstile?.remove(id)
    }
  }, [siteKey, onToken])

  React.useEffect(() => {
    if (resetSignal > 0 && widgetId.current) {
      window.turnstile?.reset(widgetId.current)
    }
  }, [resetSignal])

  return <div ref={container} />
}
