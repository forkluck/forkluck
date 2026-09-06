/**
 * The Drive watcher's timer. Next runs `register()` once per server process,
 * before the first request, which is the only place in this app that owns a
 * background loop: one process polls the Changes feed for every workspace.
 */

const STARTED = Symbol.for("forkluck.driveWatch")

/**
 * Seconds between polls, or null when the watcher is off. Unset, zero and
 * anything unreadable disable it; anything shorter than a minute is raised,
 * because a poll is a round trip to Google for the whole installation.
 */
export function driveWatchInterval(value: string | undefined): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.max(60, Math.round(seconds))
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const seconds = driveWatchInterval(process.env.DRIVE_WATCH_INTERVAL_SECONDS)
  if (seconds === null) return
  // A dev hot-reload calls register() again into the same process.
  const started = globalThis as typeof globalThis & Record<symbol, boolean>
  if (started[STARTED]) return
  started[STARTED] = true

  // Lazily, so the edge runtime never bundles the Drive client.
  const { runDriveWatchAndRead } = await import("@/lib/drive-watch")
  const poll = () => {
    void runDriveWatchAndRead().catch((cause) => {
      console.error("Drive watch threw", cause)
    })
  }
  // A fresh deploy notices what arrived while it was down without waiting a
  // whole interval; neither timer keeps a shutting-down process alive.
  setTimeout(poll, 10_000).unref()
  setInterval(poll, seconds * 1000).unref()
}
