import * as React from "react"
import { useRefresh } from "@/hooks/use-refresh"

// Two-step "arm then confirm" undo used by the import history dialogs. The
// armed state disarms itself after four seconds. Works with actions that throw
// on failure as well as actions that resolve with an { error } envelope.
export function useUndoImport(
  action: (id: string) => Promise<void | { error: string } | object>,
  { refresh: refreshAfter = true }: { refresh?: boolean } = {}
) {
  const { refresh } = useRefresh()
  const [armedId, setArmedId] = React.useState<string | null>(null)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!armedId) return
    const timer = window.setTimeout(() => setArmedId(null), 4000)
    return () => window.clearTimeout(timer)
  }, [armedId])

  const undo = async (id: string) => {
    if (armedId !== id) {
      setArmedId(id)
      return
    }
    setPendingId(id)
    setError(null)
    try {
      const result = await action(id)
      if (result && "error" in result && typeof result.error === "string") {
        setError(result.error)
        return
      }
      setArmedId(null)
      if (refreshAfter) await refresh()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn’t undo the import."
      )
    } finally {
      setPendingId(null)
    }
  }

  return { armedId, pendingId, error, undo }
}
