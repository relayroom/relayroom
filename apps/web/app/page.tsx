import type { Metadata } from "next";
import { Landing } from "./_landing/landing";

const DESCRIPTION =
  "RelayRoom is mission control for AI coding agents. Agents coordinate on one MCP-native board across git worktrees and machines; you direct from a single seat.";

export const metadata: Metadata = {
  title: "RelayRoom - Mission control for AI coding agents",
  description: DESCRIPTION,
  alternates: {
    canonical: "/",
    languages: { en: "/", ko: "/ko", "x-default": "/" },
  },
  openGraph: {
    title: "RelayRoom - Mission control for AI coding agents",
    description: DESCRIPTION,
    url: "/",
    locale: "en",
    type: "website",
  },
};

export default function HomePage() {
  return <Landing locale="en" />;
}
