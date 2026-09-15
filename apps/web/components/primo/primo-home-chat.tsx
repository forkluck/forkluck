"use client"
import * as React from "react"
import { PrimoConversation } from "@/components/primo/primo-conversation"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoHeader } from "./primo-header"
import { PrimoDropTarget } from "./primo-drop-target"

export function PrimoHomeChat({ userName }: { userName: string }) {
  const { registerInline } = usePrimo()
  React.useEffect(() => registerInline(), [registerInline])
  // The header stays outside the drop zone, so the dashed outline that
  // answers a drag sits below it rather than through it.
  return (
    <>
      <PrimoHeader home />
      <PrimoDropTarget>
        <PrimoConversation userName={userName} home />
      </PrimoDropTarget>
    </>
  )
}
