"use client"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { GuardedLink } from "@/components/navigation-blocker"

export function PrimoMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-3 break-words whitespace-normal [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:leading-6 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href ? (
              <GuardedLink href={href} className="underline underline-offset-2">
                {children}
              </GuardedLink>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-base [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
