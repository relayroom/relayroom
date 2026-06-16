"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "@wrksz/themes/client";

/**
 * Client-side Mermaid renderer for MDX docs.
 *
 * mermaid is a heavy dependency, so it is dynamically imported here — it only
 * loads on doc pages that actually contain a ```mermaid block, never in the main
 * bundle. The diagram re-renders when the resolved theme flips so light/dark both
 * look right. Wired in via mdx-components.tsx (it intercepts language-mermaid
 * fenced blocks and renders this instead of a <pre>).
 */
export function Mermaid({ chart }: { chart: string }) {
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  // mermaid requires a DOM-id-safe string; React's useId contains colons.
  const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "var(--font-geist-sans), ui-sans-serif, sans-serif",
        });
        const { svg } = await mermaid.render(domId, chart);
        if (!cancelled) {
          setSvg(svg);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, resolvedTheme, domId]);

  if (error) {
    // Fall back to the raw source so the diagram's content is never lost.
    return (
      <pre className="font-mono text-xs text-destructive">
        mermaid error: {error}
        {"\n\n"}
        {chart}
      </pre>
    );
  }

  if (!svg) {
    // Reserve vertical space while the dynamic import + render resolves.
    return <div className="my-4 h-24 animate-pulse rounded-lg bg-muted" aria-hidden />;
  }

  return (
    <div
      className="my-4 flex justify-center overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      // mermaid output is generated from our own trusted docs source.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
