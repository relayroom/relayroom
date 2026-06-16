import type { ComponentType } from "react";

import EnOverview from "./en/overview.mdx";
import EnWhy from "./en/why.mdx";
import EnConcepts from "./en/concepts.mdx";
import EnArchitecture from "./en/architecture.mdx";
import EnRelayroomMd from "./en/relayroom-md.mdx";
import EnRequirements from "./en/requirements.mdx";
import EnSelfHosting from "./en/self-hosting.mdx";
import EnAgentSetup from "./en/agent-setup.mdx";
import EnUsageFirstRun from "./en/usage-first-run.mdx";
import EnUsageProjects from "./en/usage-projects.mdx";
import EnUsageAgents from "./en/usage-agents.mdx";
import EnUsageMainAgent from "./en/usage-main-agent.mdx";
import EnWakeBudget from "./en/wake-budget.mdx";
import EnMcpTools from "./en/mcp-tools.mdx";
import EnAdapter from "./en/adapter.mdx";
import EnMultiProvider from "./en/multi-provider.mdx";
import EnCompanionTools from "./en/companion-tools.mdx";
import EnRrConsole from "./en/rr-console.mdx";
import EnTroubleshooting from "./en/troubleshooting.mdx";

import KoOverview from "./ko/overview.mdx";
import KoWhy from "./ko/why.mdx";
import KoConcepts from "./ko/concepts.mdx";
import KoArchitecture from "./ko/architecture.mdx";
import KoRelayroomMd from "./ko/relayroom-md.mdx";
import KoRequirements from "./ko/requirements.mdx";
import KoSelfHosting from "./ko/self-hosting.mdx";
import KoAgentSetup from "./ko/agent-setup.mdx";
import KoUsageFirstRun from "./ko/usage-first-run.mdx";
import KoUsageProjects from "./ko/usage-projects.mdx";
import KoUsageAgents from "./ko/usage-agents.mdx";
import KoUsageMainAgent from "./ko/usage-main-agent.mdx";
import KoWakeBudget from "./ko/wake-budget.mdx";
import KoMcpTools from "./ko/mcp-tools.mdx";
import KoAdapter from "./ko/adapter.mdx";
import KoMultiProvider from "./ko/multi-provider.mdx";
import KoCompanionTools from "./ko/companion-tools.mdx";
import KoRrConsole from "./ko/rr-console.mdx";
import KoTroubleshooting from "./ko/troubleshooting.mdx";

/** Supported docs locales. `en` is the default (the bare `/docs` redirects here). */
export const DOCS_LOCALES = ["en", "ko"] as const;
export type DocsLocale = (typeof DOCS_LOCALES)[number];
export const DEFAULT_DOCS_LOCALE: DocsLocale = "en";

export function isDocsLocale(value: string): value is DocsLocale {
  return (DOCS_LOCALES as readonly string[]).includes(value);
}

/** Sidebar sections, in order. Each docs entry belongs to one section `key`. */
export const DOCS_SECTIONS = [
  { key: "start", label: { en: "Getting started", ko: "시작하기" } },
  { key: "concepts", label: { en: "Concepts", ko: "개념" } },
  { key: "install", label: { en: "Installation", ko: "설치" } },
  { key: "usage", label: { en: "Usage", ko: "이용 안내" } },
  { key: "reference", label: { en: "Reference", ko: "레퍼런스" } },
] as const;
export type DocsSectionKey = (typeof DOCS_SECTIONS)[number]["key"];

/**
 * One nav entry per docs page. `slug` is the URL segment after the locale
 * (empty string = the locale index, e.g. `/docs/en`). `content` holds the MDX
 * component per locale; `label` holds the sidebar/nav label per locale;
 * `section` groups it in the sidebar.
 */
export interface DocsEntry {
  slug: string;
  section: DocsSectionKey;
  label: Record<DocsLocale, string>;
  content: Record<DocsLocale, ComponentType>;
}

export const DOCS_ENTRIES: DocsEntry[] = [
  // ── Getting started ──
  {
    slug: "",
    section: "start",
    label: { en: "Overview", ko: "개요" },
    content: { en: EnOverview, ko: KoOverview },
  },
  {
    slug: "why",
    section: "start",
    label: { en: "Why RelayRoom", ko: "왜 RelayRoom" },
    content: { en: EnWhy, ko: KoWhy },
  },
  // ── Concepts ──
  {
    slug: "concepts",
    section: "concepts",
    label: { en: "Concepts", ko: "개념" },
    content: { en: EnConcepts, ko: KoConcepts },
  },
  {
    slug: "architecture",
    section: "concepts",
    label: { en: "Architecture", ko: "시스템 구조" },
    content: { en: EnArchitecture, ko: KoArchitecture },
  },
  {
    slug: "relayroom-md",
    section: "concepts",
    label: { en: "RELAYROOM.md", ko: "RELAYROOM.md" },
    content: { en: EnRelayroomMd, ko: KoRelayroomMd },
  },
  // ── Installation ──
  {
    slug: "requirements",
    section: "install",
    label: { en: "Requirements", ko: "요구사항" },
    content: { en: EnRequirements, ko: KoRequirements },
  },
  {
    slug: "self-hosting",
    section: "install",
    label: { en: "Install RelayRoom", ko: "RelayRoom 설치" },
    content: { en: EnSelfHosting, ko: KoSelfHosting },
  },
  {
    slug: "agent-setup",
    section: "install",
    label: { en: "Connect an agent", ko: "에이전트 연결" },
    content: { en: EnAgentSetup, ko: KoAgentSetup },
  },
  // ── Usage ──
  {
    slug: "first-run",
    section: "usage",
    label: { en: "First-run setup", ko: "최초 설정" },
    content: { en: EnUsageFirstRun, ko: KoUsageFirstRun },
  },
  {
    slug: "projects",
    section: "usage",
    label: { en: "Projects", ko: "프로젝트" },
    content: { en: EnUsageProjects, ko: KoUsageProjects },
  },
  {
    slug: "agents",
    section: "usage",
    label: { en: "Agents", ko: "에이전트" },
    content: { en: EnUsageAgents, ko: KoUsageAgents },
  },
  {
    slug: "main-agent",
    section: "usage",
    label: { en: "Main agent", ko: "메인 에이전트" },
    content: { en: EnUsageMainAgent, ko: KoUsageMainAgent },
  },
  {
    slug: "wake-budget",
    section: "usage",
    label: { en: "Wake budget & governance", ko: "Wake 예산과 거버넌스" },
    content: { en: EnWakeBudget, ko: KoWakeBudget },
  },
  {
    slug: "rr-console",
    section: "usage",
    label: { en: "Control console (rr.sh)", ko: "운영 콘솔 (rr.sh)" },
    content: { en: EnRrConsole, ko: KoRrConsole },
  },
  // ── Reference ──
  {
    slug: "mcp-tools",
    section: "reference",
    label: { en: "MCP Tools", ko: "MCP 도구" },
    content: { en: EnMcpTools, ko: KoMcpTools },
  },
  {
    slug: "adapter",
    section: "reference",
    label: { en: "Adapter", ko: "어댑터" },
    content: { en: EnAdapter, ko: KoAdapter },
  },
  {
    slug: "multi-provider",
    section: "reference",
    label: { en: "Multi-provider", ko: "멀티 프로바이더" },
    content: { en: EnMultiProvider, ko: KoMultiProvider },
  },
  {
    slug: "companion-tools",
    section: "reference",
    label: { en: "Companion tools", ko: "함께 쓰면 좋은 도구" },
    content: { en: EnCompanionTools, ko: KoCompanionTools },
  },
  {
    slug: "troubleshooting",
    section: "reference",
    label: { en: "Troubleshooting", ko: "문제 해결" },
    content: { en: EnTroubleshooting, ko: KoTroubleshooting },
  },
];

/** Look up a docs entry by its slug (the segments after the locale, joined by `/`). */
export function findDocsEntry(slug: string): DocsEntry | undefined {
  return DOCS_ENTRIES.find((e) => e.slug === slug);
}
