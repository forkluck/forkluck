"use client"

import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@shadcn/react/message-scroller"
import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function ScrollToBottom() {
  const { end } = useMessageScrollerScrollable()
  const { scrollToEnd } = useMessageScroller()
  const [visible, setVisible] = React.useState(false)
  React.useEffect(() => {
    if (!end) {
      const timeout = window.setTimeout(() => setVisible(false), 0)
      return () => window.clearTimeout(timeout)
    }
    const timeout = window.setTimeout(() => setVisible(true), 150)
    return () => window.clearTimeout(timeout)
  }, [end])
  if (!visible) return null
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="secondary"
      aria-label="Scroll to bottom"
      className="absolute right-4 bottom-2 z-10"
      onClick={() => scrollToEnd({ behavior: "smooth" })}
    >
      <ChevronDown aria-hidden="true" />
    </Button>
  )
}

export function MessageScroller({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <MessageScrollerPrimitive.Provider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={56}
    >
      <MessageScrollerPrimitive.Root
        className={cn("relative min-h-0 flex-1", className)}
      >
        <MessageScrollerPrimitive.Viewport
          aria-label="Primo conversation"
          className="h-full overflow-y-auto overscroll-contain"
        >
          <MessageScrollerPrimitive.Content className="flex min-h-full flex-col gap-6 px-4 py-5">
            {children}
          </MessageScrollerPrimitive.Content>
        </MessageScrollerPrimitive.Viewport>
        <ScrollToBottom />
      </MessageScrollerPrimitive.Root>
    </MessageScrollerPrimitive.Provider>
  )
}

export const MessageScrollerItem = MessageScrollerPrimitive.Item
