"use client"

import { useState } from "react"
import { Menu } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The visual guide's mobile nav: the hamburger and the menu it opens.
 *
 * Marketing chrome, so it sits on guide.css rather than on the app's control
 * ladder: the button is the reference article's 33px square and the menu is
 * its 21px link stack, both hidden above 1023px by `.menu-btn` and
 * `.mobile-menu`. The only state is open or closed, which is why this is the
 * one client file under `app/design`; the menu is positioned under the nav so
 * the toggle and the panel can live together.
 */
export function NavMenu() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        data-slot="guide-menu-button"
        type="button"
        className={cn("menu-btn")}
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="guide-mobile-menu"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <Menu aria-hidden="true" size={18} />
      </button>
      <div
        data-slot="guide-mobile-menu"
        id="guide-mobile-menu"
        className={cn("mobile-menu", open && "open")}
      >
        <a href="https://app.forkluck.com">Open app</a>
        <a href="https://app.forkluck.com/signup">Start free trial</a>
      </div>
    </>
  )
}
