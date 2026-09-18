import { ImageOff } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The picture of a thing: a square photo tile at 32, 48 or 64px, `rounded-md`
 * over one `--border` hairline, the image cropped with `object-cover` so a
 * column of them keeps one edge whatever shape the file is. Tile sizes are
 * layout sizes, not control heights, the way a table row is.
 *
 * Without `src` it draws the same tile on `--fill-soft` with a muted
 * `ImageOff`, so a list with photos and a list without still line up. `alt`
 * describes the picture and labels the empty tile.
 */
const thumbnailSizes = {
  sm: "size-8",
  default: "size-12",
  lg: "size-16",
} as const

const thumbnailIcons = {
  sm: "size-3.5",
  default: "size-4",
  lg: "size-5",
} as const

function Thumbnail({
  className,
  src,
  alt,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  src?: string
  alt: string
  size?: keyof typeof thumbnailSizes
}) {
  return (
    <div
      data-slot="thumbnail"
      data-size={size}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border",
        src ? "bg-card" : "bg-fill-soft",
        thumbnailSizes[size],
        className
      )}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="size-full object-cover" />
      ) : (
        <ImageOff
          role="img"
          aria-label={alt}
          className={cn("text-muted-foreground", thumbnailIcons[size])}
        />
      )}
    </div>
  )
}

export { Thumbnail }
