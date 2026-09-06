import type { Metadata } from "next"
import localFont from "next/font/local"

import "./globals.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const bodyFont = localFont({
  src: "./fonts/Inter-Variable-Latin.woff2",
  display: "swap",
  style: "normal",
  variable: "--font-body",
  weight: "100 900",
})

export const metadata: Metadata = {
  title: {
    default: "Forkluck — Recipe analysis for chefs",
    template: "%s — Forkluck",
  },
  description:
    "Paste a kitchen formula and inspect its water, dry matter, solids, and formulation balance.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      // Browser extensions (e.g. Scribe) stamp attributes on <html> before
      // hydration; suppress attribute-mismatch noise on this element only.
      suppressHydrationWarning
      className={cn("antialiased", bodyFont.variable)}
    >
      <body>
        <TooltipProvider>
          <div className="root">{children}</div>
        </TooltipProvider>
      </body>
    </html>
  )
}
