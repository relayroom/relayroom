// Ambient type for `.mdx` imports (used by app/docs/_content/registry.ts).
// @types/mdx provides `mdx/types` but not the wildcard module declaration.
declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { MDXComponents } from "mdx/types";

  const MDXComponent: ComponentType<{ components?: MDXComponents }>;
  export default MDXComponent;
}
