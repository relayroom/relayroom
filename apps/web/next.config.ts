import type { NextConfig } from "next";
import path from "path";
import createNextIntlPlugin from "next-intl/plugin";
import createMDX from "@next/mdx";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// GFM (tables, strikethrough, autolinks) needs remark-gfm — @mdx-js/loader does
// NOT enable it by default. Turbopack can't serialize function-valued plugins,
// so pass the plugin by its string name; Next resolves the module at build time.
const withMDX = createMDX({
  options: {
    remarkPlugins: [["remark-gfm", {}]],
  },
});

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),

  // Allow .mdx files to be treated as pages/components
  pageExtensions: ["ts", "tsx", "mdx"],

  /**
   * sharp is used in the /api/media/upload route for image processing.
   *
   * Next.js 15+ standalone output traces dependencies, but sharp ships
   * platform-specific native binaries. Listing it here as a serverExternalPackage
   * tells Next to bundle it as a real require() rather than inlining it, which
   * ensures the native .node addon is loaded from node_modules at runtime.
   *
   * For Alpine (Docker): sharp >=0.33 ships prebuilt musl binaries via
   * @img/sharp-linux-x64-musl, so no extra apk packages are needed.
   * If you see "Could not load the \"sharp\" module", add to the Dockerfile:
   *   RUN apk add --no-cache vips-dev
   * or pin to an older sharp that bundles libvips statically.
   */
  serverExternalPackages: ["sharp"],
};

export default withNextIntl(withMDX(nextConfig));
