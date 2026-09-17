"use client"

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

/**
 * A box that scrolls its own content instead of the page: a long list inside a
 * dialog, a components picker, a popover that holds more rows than it is tall.
 * The call site sets the height; this only owns the scrolling and the bar.
 *
 * The bar is 6px of `--line-strong`, `rounded-full` — the same grey a field's
 * line firms to on hover, so the thumb reads as chrome rather than as content.
 * It is not on the control height ladder: nothing stands beside it in a
 * toolbar, and a 20px thumb would be a bar, not a position mark.
 */
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full overscroll-contain outline-none",
          viewportClassName
        )}
      >
        <ScrollAreaPrimitive.Content data-slot="scroll-area-content">
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        orientation="vertical"
        className="m-0.5 flex w-1.5 justify-center rounded-full opacity-0 transition-opacity select-none data-hovering:opacity-100 data-scrolling:opacity-100"
      >
        <ScrollAreaPrimitive.Thumb
          data-slot="scroll-area-thumb"
          className="w-full rounded-full bg-line-strong"
        />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  )
}

export { ScrollArea }
