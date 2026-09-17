import { headers } from "next/headers"

/**
 * This Next process answers on two public hosts. A workspace is never indexed,
 * so app.forkluck.com (and anything else that reaches the process) keeps the
 * blanket Disallow; design.forkluck.com is the visual guide, a public article
 * that is meant to be found, so it allows everything. The public site is Ghost
 * at forkluck.com, which serves its own robots.txt and sitemap.
 */
const DESIGN_HOST = "design.forkluck.com"

export async function GET() {
  const host = (await headers()).get("host")
  const body =
    host === DESIGN_HOST
      ? "User-agent: *\nAllow: /\n"
      : "User-agent: *\nDisallow: /\n"

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
