import * as React from "react"

/** Cmd/Ctrl+S saves the screen, committing the focused field first. */
export function useSaveShortcut(save: () => void | Promise<unknown>) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return
      event.preventDefault()
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      void save()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [save])
}

/** Cmd/Ctrl+S inside a dialog submits that dialog, never the screen behind it. */
export function dialogSaveShortcut(submit: () => void) {
  return (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return
    event.preventDefault()
    event.stopPropagation()
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    submit()
  }
}
