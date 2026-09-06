"use client"
import * as React from "react"
import { Plus } from "lucide-react"
import { PrimoConversation } from "@/components/primo/primo-conversation"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoRecent } from "@/components/primo/primo-recent"
import { Button } from "@/components/ui/button"
import { PrimoDropTarget } from "./primo-drop-target"

export function PrimoHomeChat({ userName }: { userName: string }) {
  const { registerInline, newChat } = usePrimo()
  React.useEffect(() => registerInline(), [registerInline])
  return (
    <PrimoDropTarget>
      <header className="mx-auto mb-4 flex w-full max-w-[1000px] shrink-0 items-center justify-end gap-2 px-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            aria-label="New chat"
            className="w-8 px-0 text-ink-soft sm:w-auto sm:px-3"
            onClick={newChat}
          >
            <Plus aria-hidden="true" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
          <PrimoRecent />
        </div>
      </header>
      <PrimoConversation userName={userName} home />
    </PrimoDropTarget>
  )
}
