"use client"

import * as React from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { MARKETING_ORIGIN } from "@/lib/public-site"

/**
 * The page a guest reads a share on: a wordmark bar out to Forkluck, one
 * column of prose, and the line that says where this came from. A shared
 * recipe and a shared book differ only in what sits between them.
 */
export function GuestPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-card">
      <header className="sticky top-0 z-10 border-b border-border bg-card print:static print:border-0">
        <div className="flex h-14 items-center justify-between gap-4 px-6">
          <a
            href={MARKETING_ORIGIN}
            aria-label="Forkluck home"
            className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
          >
            <span className="text-lg leading-none font-semibold tracking-[-0.01em]">
              Forkluck
            </span>
          </a>
          <div className="flex items-center gap-2 print:hidden">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/login" />}
            >
              Sign in
            </Button>
            <Button nativeButton={false} render={<Link href="/signup" />}>
              Get started
            </Button>
          </div>
        </div>
      </header>

      {/* Prose, not dashboard chrome, so it keeps the 1.5 leading <body> gives up. */}
      <main className="px-6 py-12 leading-normal print:py-0">
        <div className="mx-auto grid w-full max-w-[44rem] gap-10">
          {children}

          <footer className="text-sm text-muted-foreground">
            Shared with you on Forkluck
          </footer>
        </div>
      </main>
    </div>
  )
}
