import * as React from "react"

import type { SaveStatusState } from "@/components/ui/save-status"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"

/** Field id → what is wrong with it. The first one gets the focus. */
export type FormErrors = Record<string, string>

type Options = {
  /** A string that changes whenever the form changes. */
  snapshot: string
  /** False for a form that writes on every submit: it is never clean. */
  saved?: boolean
  /** Run before every submit; anything it returns blocks the request. */
  validate?: () => FormErrors
  /** Resolves null when the write landed. */
  save: () => Promise<SaveFailure | null>
}

type FormSave = {
  pending: boolean
  dirty: boolean
  errors: FormErrors
  saveState: SaveStatusState
  /** The last failure a request answered with; validation lives in `errors`. */
  failure: SaveFailure | null
  /** True once the form is saved — what a dialog waits for before closing. */
  submit: () => Promise<boolean>
}

/** One submit at a time, and the form only ever clears after it lands. */
export function useFormSave({
  snapshot,
  saved = true,
  validate,
  save,
}: Options): FormSave {
  // What the server holds, null until it holds anything. Only ever advances to
  // a snapshot a save sent.
  const [baseline, setBaseline] = React.useState<string | null>(
    saved ? snapshot : null
  )
  // A never-saved form is clean until it moves, even though it always sends.
  const [opened] = React.useState(snapshot)
  const [pending, setPending] = React.useState(false)
  const [errors, setErrors] = React.useState<FormErrors>({})
  const [failure, setFailure] = React.useState<SaveFailure | null>(null)
  const [saveState, setSaveState] = React.useState<SaveStatusState>("saved")
  // Read at submit time rather than closed over when the button was drawn.
  const current = React.useRef({ snapshot, baseline, validate, save, saved })
  React.useEffect(() => {
    current.current = { snapshot, baseline, validate, save, saved }
  })
  const inFlight = React.useRef(false)

  // Inline errors clear as soon as the form moves; a request failure keeps its
  // message.
  const [checked, setChecked] = React.useState(snapshot)
  if (checked !== snapshot) {
    setChecked(snapshot)
    if (Object.keys(errors).length > 0) setErrors({})
  }

  const submit = React.useCallback(async () => {
    // A second press while the first is running would write twice.
    if (inFlight.current) return false
    const found = current.current.validate?.() ?? {}
    const [firstField] = Object.keys(found)
    if (firstField !== undefined) {
      setErrors(found)
      document.getElementById(firstField)?.focus()
      return false
    }
    setErrors({})
    // Read before the first await: only this much reaches the server.
    const sent = current.current.snapshot
    // Nothing changed, so nothing is sent — and no version is spent.
    if (current.current.baseline !== null && sent === current.current.baseline)
      return true
    inFlight.current = true
    setPending(true)
    setSaveState("saving")
    let result: SaveFailure | null
    try {
      result = await current.current.save()
    } catch (error) {
      result = toSaveFailure(error)
    }
    inFlight.current = false
    setPending(false)
    if (result) {
      setFailure(result)
      setSaveState(result.kind === "conflict" ? "conflict" : "error")
      return false
    }
    setFailure(null)
    if (current.current.saved) setBaseline(sent)
    setSaveState("saved")
    return true
  }, [])

  return {
    pending,
    dirty: snapshot !== (baseline ?? opened),
    errors,
    saveState,
    failure,
    submit,
  }
}
