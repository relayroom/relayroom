import type { ReactNode } from "react"

/**
 * Brand monogram (official RelayRoom RR mark). Pure SVG — safe in a server
 * component. The main shape uses `currentColor` so it adapts to the surrounding
 * text color (navy in light, near-white in dark); the relay triangle is the Teal
 * accent. Matches public/brand/relayroom-mark.svg.
 */
export function RRMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 166 126" role="img" aria-label="RelayRoom" fill="none">
      <path
        fillRule="evenodd"
        fill="currentColor"
        d="M86.5 7.3L125.3 7.5L130.0 8.2L137.0 10.4L142.3 12.9L148.0 17.2L152.5 22.3L156.3 28.7L158.8 37.0L159.5 41.3L159.5 46.7L157.7 55.3L154.9 62.0L150.8 67.7L147.0 71.5L141.0 75.6L135.7 77.7L133.5 79.3L134.2 80.7L162.5 116.0L164.4 118.7L164.0 119.7L142.0 119.4L140.5 118.0L130.5 104.7L111.3 80.8L109.3 79.8L102.0 79.8L101.3 79.4L101.2 69.7L101.8 65.3L102.7 63.7L122.7 63.5L126.3 62.8L132.0 60.6L137.2 56.3L139.6 52.3L141.5 46.3L141.5 41.0L140.3 36.7L136.5 31.0L132.3 27.7L128.7 26.1L123.3 24.8L96.0 24.6L90.8 16.3L87.5 12.3L83.3 8.3L83.7 7.5L86.3 7.4ZM6.9 7.7L55.0 7.5L57.7 7.8L65.3 10.1L72.0 13.4L76.3 16.5L79.5 19.7L82.6 24.0L85.6 29.7L87.8 37.0L88.2 46.0L86.8 53.3L84.7 58.7L80.5 65.3L75.7 70.2L68.0 74.7L66.8 76.0L70.2 80.3L77.5 88.3L78.8 90.7L78.7 116.9L77.2 116.0L64.2 100.7L37.8 71.0L38.1 67.7L40.2 64.0L41.0 63.4L42.3 62.8L53.3 62.8L57.3 61.8L62.3 59.2L65.8 56.0L68.8 51.0L70.2 45.0L69.8 39.7L67.9 34.7L65.8 31.7L62.0 28.2L58.0 26.1L53.3 24.8L26.7 24.8L25.3 25.6L24.8 26.7L24.8 118.7L24.0 119.5L8.7 119.5L7.7 119.8L6.4 119.0L6.2 8.7L6.7 7.8Z"
      />
      <path fill="#14b8a6" d="M78.8 90.0L80.5 91.3L99.5 112.7L104.8 119.3L104.3 119.8L80.7 119.8L78.2 117.7L78.8 116.7L78.7 90.3Z" />
    </svg>
  )
}

const s = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
}

/** Feature icons keyed by name (see copy `icon` fields). */
export const ICONS: Record<string, ReactNode> = {
  message: (
    <svg {...s}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
  ),
  activity: (
    <svg {...s}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
  ),
  cpu: (
    <svg {...s}><rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" /></svg>
  ),
  check: (
    <svg {...s}><path d="M20 6 9 17l-5-5" /></svg>
  ),
  machine: (
    <svg {...s}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
  ),
  branch: (
    <svg {...s}><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
  ),
}

const small = { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }

export const IconX = (
  <svg {...small}><path d="M18 6 6 18M6 6l12 12" /></svg>
)
export const IconOk = (
  <svg {...small}><path d="M20 6 9 17l-5-5" /></svg>
)
