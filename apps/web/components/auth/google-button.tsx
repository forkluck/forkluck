"use client"

import { useEffect, useState } from "react"

import { GoogleIcon } from "@/components/auth/google-icon"
import { writeLastSignInMethod } from "@/components/auth/last-sign-in-method"
import { buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export function GoogleButton({ next = "/" }: { next?: string }) {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    // Back from Google's screen can restore this document from the bfcache.
    const restored = () => setPending(false)
    window.addEventListener("pageshow", restored)
    return () => window.removeEventListener("pageshow", restored)
  }, [])

  return (
    <a
      href={
        next === "/"
          ? "/api/auth/google/start"
          : `/api/auth/google/start?next=${encodeURIComponent(next)}`
      }
      className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault()
          return
        }
        writeLastSignInMethod("google")
        // A modified click opens another document; this one stays usable.
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        )
          setPending(true)
      }}
    >
      {pending ? (
        <Spinner size="sm" label="" data-icon="inline-start" />
      ) : (
        <GoogleIcon className="size-4" />
      )}
      Continue with Google
    </a>
  )
}
