"use client"
import * as React from "react"

/** The keyboard can shrink the visible viewport without resizing the layout viewport. */
export function useVisualViewport(enabled: boolean) {
  const [viewport, setViewport] = React.useState<{
    height: number
    top: number
  } | null>(null)
  React.useEffect(() => {
    if (!enabled) return
    const visible = window.visualViewport
    const update = () =>
      setViewport({
        height: visible?.height ?? window.innerHeight,
        top: visible?.offsetTop ?? 0,
      })
    update()
    visible?.addEventListener("resize", update)
    visible?.addEventListener("scroll", update)
    window.addEventListener("resize", update)
    return () => {
      visible?.removeEventListener("resize", update)
      visible?.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [enabled])
  return enabled ? viewport : null
}
