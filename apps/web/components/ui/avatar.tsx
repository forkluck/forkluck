"use client"

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A person, at one of three rungs of the control ladder: `sm` 24px, `default`
 * 32px, `lg` 36px, so an avatar in a toolbar or a table row lines up with the
 * buttons around it. Always `rounded-full` on `--secondary`, the same grey the
 * secondary button is filled with, because a face is neither an action nor
 * data.
 *
 * `AvatarImage` covers the circle; `AvatarFallback` holds the initials and
 * shows whenever there is no image or the image fails. Initials step down with
 * the size — 11.5px, 12.5px, 13px — and never carry colour of their own.
 */
const avatarSizes = {
  sm: "size-6 text-2xs",
  default: "size-8 text-xs",
  lg: "size-9 text-sm",
} as const

function Avatar({
  className,
  size = "default",
  ...props
}: AvatarPrimitive.Root.Props & { size?: keyof typeof avatarSizes }) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary font-medium text-foreground select-none",
        avatarSizes[size],
        className
      )}
      {...props}
    />
  )
}

/** The photo, filling the circle. */
function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("size-full object-cover", className)}
      {...props}
    />
  )
}

/** Initials, or whatever stands in when there is no photo. */
function AvatarFallback({
  className,
  ...props
}: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center leading-none",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarFallback, AvatarImage }
