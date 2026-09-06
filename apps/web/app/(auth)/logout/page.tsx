"use client"

import * as React from "react"

import { authClient } from "@/lib/auth-client"
import { MARKETING_ORIGIN } from "@/lib/public-site"

export default function LogoutPage() {
  React.useEffect(() => {
    // Signing out clears the forkluck_signed_in cookie, so the marketing
    // header we land on is already back to Sign in. A failed call still lands.
    void authClient
      .signOut()
      .finally(() => window.location.replace(MARKETING_ORIGIN))
  }, [])

  return <p className="text-center text-muted-foreground">Signing you out…</p>
}
