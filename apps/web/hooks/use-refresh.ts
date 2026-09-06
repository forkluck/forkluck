import * as React from "react"
import { useRouter } from "next/navigation"

/**
 * `router.refresh()` as part of the wait, not the end of it. On its own the
 * call returns at once and the re-render lands a round trip later, so a
 * button that stops spinning when the action answers stops before the rows
 * change. Run inside a transition, the refresh keeps `pending` up until the
 * new payload has committed, and `refresh()` resolves at that moment, which
 * is when a dialog may close or a toast may say the thing is done.
 *
 *   const { pending: refreshing, refresh } = useRefresh()
 *   <Button pending={saving || refreshing} …>
 *   await refresh()   // the screen now shows the result
 *
 * Inside an async React transition, use `void refresh()` instead. React
 * joins the refresh to the outer transition; awaiting its completion there
 * makes the transition wait on itself. Follow-up work can use `.then()`
 * without returning that promise from the transition callback.
 */
export function useRefresh() {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const waiting = React.useRef<(() => void)[]>([])

  const settle = React.useCallback(() => {
    const resolvers = waiting.current
    waiting.current = []
    for (const resolve of resolvers) resolve()
  }, [])

  // The transition's end is the only signal the refresh has landed.
  React.useEffect(() => {
    if (!pending) settle()
  }, [pending, settle])
  // A screen the refresh unmounts still answers whoever was waiting on it.
  React.useEffect(() => settle, [settle])

  const refresh = React.useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiting.current.push(resolve)
        startTransition(() => router.refresh())
      }),
    [router]
  )

  return { pending, refresh }
}
