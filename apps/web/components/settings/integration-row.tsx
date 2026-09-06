import * as React from "react"
import Image from "next/image"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * One place documents come from, as a row in the Connections list: the
 * service's mark, its name with a status dot, one line saying what it does
 * and how it stands, and its actions on the right. The Drive folder and the
 * supplier connectors share it so the list reads as one.
 */
export function IntegrationRow({
  logo,
  icon: Icon,
  name,
  status,
  description,
  error,
  note,
  actions,
  dimmed = false,
}: {
  /** The service's own mark, from /public; absent, the icon tile stands in. */
  logo?: { src: string; alt: string } | null
  icon: LucideIcon
  name: string
  status?: React.ReactNode
  description: React.ReactNode
  error?: string | null
  /** A quiet caveat under the status, such as a scope the provider limits. */
  note?: React.ReactNode
  actions?: React.ReactNode
  /** Not available here: drawn, but quiet. */
  dimmed?: boolean
}) {
  return (
    <div
      data-slot="integration-row"
      className={cn(
        "flex flex-wrap items-center gap-4 border-b border-muted p-4 last:border-b-0",
        dimmed && "opacity-60"
      )}
    >
      {logo ? (
        <Image
          src={logo.src}
          alt={logo.alt}
          width={40}
          height={40}
          className="size-10 flex-none object-contain"
        />
      ) : (
        <span className="flex size-10 flex-none items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-md font-medium text-foreground">{name}</span>
          {status}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          {description}
        </span>
        {error ? (
          <span className="mt-1 block text-xs leading-[1.55] text-destructive">
            {error}
          </span>
        ) : null}
        {note ? (
          <span className="mt-1 block text-xs leading-[1.55] text-faint">
            {note}
          </span>
        ) : null}
      </span>
      {actions ? (
        <span className="flex flex-none items-center gap-2">{actions}</span>
      ) : null}
    </div>
  )
}
