import * as React from "react"

import type { Sortable } from "@shopify/draggable"

/**
 * Drag rows of `container` to reorder them. Rows are `[data-sortable-row]`,
 * the grip `[data-drag-handle]`. The DOM is put back the way React rendered
 * it before `onReorder` runs, so React's and the browser's order never drift.
 */
export function useSortableRows(
  container: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onReorder: (fromIndex: number, toIndex: number) => void
) {
  const onReorderRef = React.useRef(onReorder)
  React.useEffect(() => {
    onReorderRef.current = onReorder
  }, [onReorder])

  React.useEffect(() => {
    const node = container.current
    if (!node || !enabled) return

    let sortable: Sortable | null = null
    let cancelled = false
    let renderedOrder: Element[] = []

    void import("@shopify/draggable").then(({ Sortable }) => {
      if (cancelled) return
      sortable = new Sortable(node, {
        draggable: "[data-sortable-row]",
        handle: "[data-drag-handle]",
        mirror: { constrainDimensions: true },
        // A touch delay keeps one-finger page scrolling alive in the kitchen.
        delay: { mouse: 0, drag: 0, touch: 200 },
      })
      sortable.on("sortable:start", () => {
        renderedOrder = sortable
          ? sortable.getDraggableElementsForContainer(node)
          : []
      })
      sortable.on("sortable:stop", (event) => {
        const { oldIndex, newIndex } = event
        for (const row of renderedOrder) node.appendChild(row)
        renderedOrder = []
        if (oldIndex !== newIndex) onReorderRef.current(oldIndex, newIndex)
      })
    })

    return () => {
      cancelled = true
      sortable?.destroy()
    }
  }, [container, enabled])
}

/** The grip's classes: hidden until its row is hovered, shown while dragged. */
export const dragHandleClassName =
  "flex h-8 w-4 cursor-grab items-center text-disabled-foreground opacity-0 group-hover/row:opacity-100 hover:text-faint [.draggable-source--is-dragging_&]:opacity-100 [.draggable-mirror_&]:opacity-100"
