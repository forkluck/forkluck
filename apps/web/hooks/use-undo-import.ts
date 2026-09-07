import * as React from "react"

// Two-step "arm then confirm" undo used by the import history dialogs. The
// armed state disarms itself after four seconds. Works with actions that throw
// on failure as well as actions that resolve with an { error } envelope. The
// screen behind the dialog follows from the action's own revalidation.
export function useUndoImport(
  action: (id: string) => Promise<void | { error: string } | object>
) {
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
