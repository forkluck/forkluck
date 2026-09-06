import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { Search as SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * 36px, `rounded-md`, one `--border` hairline, 400 14px. Hover firms the line
 * to `--line-strong`, focus takes it to ink — there is no focus ring anywhere
 * in this design. Search fields are the 32px variant on the same radius, so a
 * toolbar's search and its buttons share one corner: add `className="h-8"`.
 *
 * Chrome paints an autofilled field pale blue, which is the fill this design
 * reserves for a selected card. The inset shadow below covers it with the
 * card fill and keeps the text ink.
 *
 * Prefixes and suffixes (`$`, `%`, `/ hour`, `.myshopify.com`) go through
 * `InputGroup` + `InputAffix`, which own the 12px inset and the vertical
 * centering. The call site still pads the input past the affix, since only it
 * knows how wide the affix is:
 *
 *   <InputGroup>
 *     <InputAffix>$</InputAffix>
 *     <Input className="pl-[26px]" … />
 *     <InputAffix side="end">/ hour</InputAffix>
 *   </InputGroup>
 */
// text-lg below md keeps iOS from zooming the page on focus.
const inputClassName =
  "h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 text-lg leading-6 text-foreground outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-md file:leading-5 file:font-medium file:text-foreground placeholder:text-faint autofill:shadow-[inset_0_0_0_1000px_var(--card)] autofill:[-webkit-text-fill-color:var(--foreground)] focus-visible:border-foreground enabled:not-focus:hover:border-line-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-fill-soft disabled:text-faint aria-invalid:border-destructive md:text-md"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  )
}

/** Positioning context for an affixed input. */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn("relative", className)}
      {...props}
    />
  )
}

/**
 * A `$` / `%` / `/ hour` sitting on the input's own padding: 12px in, faint,
 * and never a click target — the field behind it stays the whole hit area.
 * Centered on the field rather than pinned to a hard offset, so it lands right
 * on both the 36px input and the 32px search pill.
 */
function InputAffix({
  className,
  side = "start",
  ...props
}: React.ComponentProps<"span"> & { side?: "start" | "end" }) {
  return (
    <span
      data-slot="input-affix"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-1/2 -translate-y-1/2 text-md leading-none text-faint select-none",
        side === "start" ? "left-3" : "right-3",
        className
      )}
      {...props}
    />
  )
}

/**
 * The toolbar's search field: a 196px 32px pill with a 15px magnifier 12px in.
 * Every screen's toolbar opens with this one — `DataTable` renders it, and a
 * screen that owns its own filtering (Products) renders it too.
 */
function SearchInput({
  className,
  inputClassName,
  label = "Search",
  ...props
}: React.ComponentProps<"input"> & {
  label?: string
  /** For the input itself; `className` sizes the group. */
  inputClassName?: string
}) {
  return (
    <InputGroup className={cn("w-full max-w-[196px] flex-none", className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 size-[15px] -translate-y-1/2 text-faint"
        strokeWidth={2}
        aria-hidden="true"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder="Search"
        // The browser's own history dropdown lands on top of the results the
        // field is filtering, and its native ✕ clears the DOM without telling
        // React — the box would read empty while `?q=` still filtered the rows.
        // The magnifier is ours; the field carries no other chrome.
        autoComplete="off"
        {...props}
        className={cn(
          "h-8 pr-3 pl-[33px] text-sm md:text-sm",
          "[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden",
          inputClassName
        )}
      />
    </InputGroup>
  )
}

export { Input, InputAffix, InputGroup, SearchInput, inputClassName }
