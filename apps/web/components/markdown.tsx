import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"

// Override img to avoid surprise network calls and layout breakage.
// Renders alt text as a link to the src URL instead.
const components: Components = {
  img({ src, alt }) {
    const href = typeof src === "string" ? src : undefined
    if (href) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {alt || href}
        </a>
      )
    }
    return <span>{alt}</span>
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  },
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
