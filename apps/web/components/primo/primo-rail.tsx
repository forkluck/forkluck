"use client"

import { useVisualViewport } from "@/hooks/use-visual-viewport"
import { HatGlasses, Plus, X } from "lucide-react"

import { PrimoConversation } from "@/components/primo/primo-conversation"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoRecent } from "@/components/primo/primo-recent"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { PrimoDropTarget } from "./primo-drop-target"

function PrimoHeader({ onClose }: { onClose: () => void }) {
  const { chat, newChat } = usePrimo()
  return (
    <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2.5">
        <HatGlasses
          className="size-[18px]"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="font-heading text-lg font-semibold tracking-tight text-foreground">
          Primo
        </span>
      </div>
      <div className="flex items-center gap-1">
        <PrimoRecent />
        {chat.messages.length ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={newChat}
            aria-label="New chat"
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label="Close Primo"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

function PrimoSurface({
  userName,
  onClose,
}: {
  userName: string
  onClose: () => void
}) {
  return (
    <PrimoDropTarget id="primo-rail" className="h-full bg-background">
      <PrimoHeader onClose={onClose} />
      <PrimoConversation userName={userName} />
    </PrimoDropTarget>
  )
}

export function PrimoRail({
  userName,
  onClose,
}: {
  userName: string
  onClose: () => void
}) {
  const { open, setOpen, isDesktop, inlineCount } = usePrimo()
  const viewport = useVisualViewport(open && !isDesktop)
  if (!open || inlineCount > 0) return null
  if (isDesktop) {
    return (
      <aside
        aria-label="Primo"
        className="hidden h-full min-h-0 border-l border-border bg-background lg:flex lg:flex-col print:hidden"
      >
        <PrimoSurface userName={userName} onClose={onClose} />
      </aside>
    )
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        size="full"
        style={
          viewport
            ? {
                height: Math.max(160, viewport.height - 32),
                top: viewport.top + 16,
              }
            : undefined
        }
        className="top-4 flex h-dvh translate-y-0 flex-col gap-0 p-0 lg:hidden"
      >
        <DialogTitle className="sr-only">Primo</DialogTitle>
        <PrimoSurface userName={userName} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}
