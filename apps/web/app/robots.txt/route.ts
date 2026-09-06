/**
 * This server is app.forkluck.com only, and a workspace is never indexed, so
 * the answer is the same for every host. The public site is Ghost at
 * forkluck.com, which serves its own robots.txt and sitemap.
 */
export async function GET() {
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
