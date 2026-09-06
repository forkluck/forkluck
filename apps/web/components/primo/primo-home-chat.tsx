"use client"
import * as React from "react"
import { Plus } from "lucide-react"
import { PrimoConversation } from "@/components/primo/primo-conversation"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoRecent } from "@/components/primo/primo-recent"
import { Button } from "@/components/ui/button"
import { PrimoDropTarget } from "./primo-drop-target"

export function PrimoHomeChat({
  tabs,
  topProductName,
  userName,
}: {
  tabs: React.ReactNode
  topProductName: string
  userName: string
}) {
  const { registerInline, newChat } = usePrimo()
  React.useEffect(() => registerInline(), [registerInline])
  return (
    <PrimoDropTarget>
      <header className="mx-auto mb-4 grid w-full max-w-[1000px] shrink-0 grid-cols-[auto_1fr] items-center gap-2 px-4 lg:grid-cols-[1fr_auto_1fr]">
        <div className="lg:col-start-2">{tabs}</div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            aria-label="New chat"
            className="w-8 px-0 sm:w-auto sm:px-3"
            onClick={newChat}
          >
            <Plus aria-hidden="true" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
          <PrimoRecent />
        </div>
      </header>
      <PrimoConversation
        userName={userName}
        home
        topProductName={topProductName}
      />
    </PrimoDropTarget>
  )
}
