import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

// A link leaves the dashboard for http and https alone, in a new tab without opener or referrer. Any
// other scheme, and a link relative to the dashboard, reads as its text. An image reads as its
// alternative text, so a turn loads nothing from elsewhere. A table scrolls sideways in its bubble
// rather than squeezing its columns.
const components: Components = {
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => <>{alt}</>,
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}

// Prose renders the markdown of a turn in the chat's typeset. Raw HTML in it reads as text, since
// react-markdown renders none without a plugin that asks for it.
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("typeset typeset-chat", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
