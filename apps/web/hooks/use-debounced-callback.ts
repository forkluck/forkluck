import * as React from "react"

/**
 * Trailing-edge debounce with a stable identity: the returned function does not
 * change when `callback` does, so a caller can depend on it without restarting
 * the timer mid-typing.
 *
 * `cancel()` drops a pending call. Use it when something other than the user
 * has taken over the value being debounced — a back/forward navigation, a
 * programmatic reset — so the stale trailing call cannot overwrite it.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number
) {
  const callbackRef = React.useRef(callback)
  React.useEffect(() => {
    callbackRef.current = callback
  })

  const timerRef = React.useRef<number | null>(null)

  const cancel = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  React.useEffect(() => cancel, [cancel])

  return React.useMemo(() => {
    const run = (...args: Args) => {
      cancel()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        callbackRef.current(...args)
      }, delayMs)
    }
    run.cancel = cancel
    return run
  }, [delayMs, cancel])
}
