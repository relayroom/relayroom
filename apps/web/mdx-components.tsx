import type { MDXComponents } from "mdx/types";
import type { ReactElement } from "react";
import Link from "next/link";
import { Mermaid } from "@/components/mermaid";

/**
 * Global MDX component overrides for App Router.
 * Most body styling comes from the `prose` wrapper in docs/layout.tsx.
 * These overrides wire up Next.js Link for anchors and apply font-mono for code.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    // Headings: rendered as-is; prose plugin handles sizing
    h1: ({ children, ...props }) => (
      <h1 {...props}>{children}</h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 {...props}>{children}</h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 {...props}>{children}</h3>
    ),
    // Links: use Next.js Link for internal hrefs
    a: ({ href, children, ...props }) => {
      const isInternal = href && (href.startsWith("/") || href.startsWith("#"));
      if (isInternal) {
        return (
          <Link href={href} {...props}>
            {children}
          </Link>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    // Screenshots / figures: rounded, bordered, lazy-loaded.
    img: ({ src, alt }) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={typeof src === "string" ? src : ""}
        alt={alt ?? ""}
        loading="lazy"
        className="rounded-lg border border-border shadow-sm"
      />
    ),
    // Inline code: monospace, subtle background
    code: ({ children, ...props }) => (
      <code className="font-mono" {...props}>
        {children}
      </code>
    ),
    // Block code: monospace. A ```mermaid fence arrives as <pre><code
    // class="language-mermaid">…</code></pre>; intercept it and render the
    // diagram client-side instead of a plain code block.
    pre: ({ children, ...props }) => {
      const child = children as ReactElement<{ className?: string; children?: string }> | undefined;
      const className = child?.props?.className ?? "";
      if (className.includes("language-mermaid")) {
        return <Mermaid chart={String(child?.props?.children ?? "").trim()} />;
      }
      return (
        <pre className="font-mono" {...props}>
          {children}
        </pre>
      );
    },
    ...components,
  };
}
