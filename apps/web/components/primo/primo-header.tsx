"use client"

import * as React from "react"
import { Maximize2, Plus, X } from "lucide-react"
import { usePrimo } from "./primo-provider"
import { PrimoRecent } from "./primo-recent"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function PrimoHeader({
  home = false,
  onClose,
}: {
  home?: boolean
  onClose?: () => void
}) {
  const { conversationId, conversations, newChat, navigate, chat } = usePrimo()
  const [expanding, setExpanding] = React.useState(false)
  const title = conversations.find((row) => row.id === conversationId)?.title
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-1 px-3 py-3",
        home ? "mx-auto w-full max-w-[760px]" : "border-b border-border"
      )}
    >
      <PrimoRecent
        title={title || (chat.messages.length ? "New chat" : "Primo")}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="New chat"
              onClick={newChat}
            />
          }
        >
          <Plus aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>New chat</TooltipContent>
      </Tooltip>
      {!home ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Expand Primo"
                pending={expanding}
                onClick={async () => {
                  setExpanding(true)
                  try {
                    await navigate("/")
                  } finally {
                    setExpanding(false)
                  }
                }}
              />
            }
          >
            <Maximize2 aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Expand Primo</TooltipContent>
        </Tooltip>
      ) : null}
      {onClose ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close Primo"
                onClick={onClose}
              />
            }
          >
            <X aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Close Primo</TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  )
}
