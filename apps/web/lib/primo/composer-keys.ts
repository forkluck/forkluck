export type ComposerKeyAction = "send" | "newline" | "pick" | "close" | "none"

export function resolveComposerKey(
  event: {
    key: string
    shiftKey?: boolean
    keyCode?: number
    isComposing?: boolean
  },
  state: { pickerOpen: boolean; hasPickerOptions: boolean }
): ComposerKeyAction {
  if (event.isComposing || event.keyCode === 229) return "none"
  if (state.pickerOpen && event.key === "Escape") return "close"
  if (state.pickerOpen && state.hasPickerOptions && event.key === "Enter") {
    return "pick"
  }
  if (event.key !== "Enter") return "none"
  return event.shiftKey ? "newline" : "send"
}
